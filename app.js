require('dotenv').config();
const OpenAI = require("openai");
const { Anthropic } = require("@anthropic-ai/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const r2 = require('./lib/r2'); // 内部で process.env.R2_SECRET_ACCESS_KEY 等を参照する想定
const { cosineSimilarity } = require('./lib/utils');

/**
 * Multi-Provider Orchestrator
 * * 必要環境変数:
 * - OPENAI_API_KEY
 * - ANTHROPIC_API_KEY
 * - GEMINI_API_KEY
 * - R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 */

async function run() {
  console.log("=== START: Multi-Provider Orchestrator ===");
  const errorLogs = [];
  
  const logError = (context, message, details = null) => {
    errorLogs.push({ 
      time: new Date().toLocaleString('ja-JP'), 
      context, 
      message, 
      details 
    });
    console.error(`[${context}] ${message} ${details ? `(${details})` : ''}`);
  };

  // 0. 設定ファイルの読み込み
  const configStr = await r2.download('prompts.json');
  if (!configStr) {
    throw new Error("CRITICAL: prompts.json could not be downloaded from R2.");
  }
  const config = JSON.parse(configStr);
  const settings = config.settings;

  // 1. 各プロバイダーの初期化（環境変数から取得）
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const googleAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  /**
   * AI実行の抽象化関数
   */
  const askAI = async (model, systemPrompt, userContent) => {
    try {
      if (model.startsWith('gpt') || model.startsWith('o3')) {
        const res = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
          ]
        });
        return res.choices[0].message.content;
      } 
      else if (model.startsWith('claude')) {
        const res = await anthropic.messages.create({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: "user", content: userContent }]
        });
        return res.content[0].text;
      } 
      else if (model.startsWith('gemini')) {
        const genModel = googleAI.getGenerativeModel({ model });
        const res = await genModel.generateContent({
          contents: [{ 
            role: 'user', 
            parts: [{ text: `System Instruction: ${systemPrompt}\n\nUser: ${userContent}` }] 
          }]
        });
        return res.response.text();
      }
      throw new Error(`Unsupported model: ${model}`);
    } catch (e) {
      logError("AI_API", `Model ${model} failed`, e.message);
      throw e;
    }
  };

  // 2. RSS取得
  let allItems = [];
  const parser = new Parser();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (settings.fetch_days || 3));

  for (const url of config.rss_feeds) {
    try {
      const feed = await parser.parseURL(url);
      allItems.push(...feed.items.filter(i => new Date(i.pubDate) > cutoff));
    } catch (e) {
      logError("RSS_FETCH", url, e.message);
    }
  }

  // 既読管理・ベクトルDBのダウンロード
  const db = JSON.parse(await r2.download('articles_db.json') || "[]");
  const vectorDb = JSON.parse(await r2.download('vectors.json') || "[]");
  
  // 新着記事のみ抽出
  const pending = allItems.filter(i => !db.some(d => d.link === i.link));
  if (pending.length === 0) {
    console.log("No new articles found.");
    return;
  }

  // 3. フィルタリングステップ
  const filterStep = config.workflow.find(s => s.id === 'filter' && s.enabled);
  let targets = pending;

  if (filterStep) {
    try {
      console.log("--- Executing AI Filter ---");
      const filterRes = await askAI(
        filterStep.model, 
        `${filterStep.prompt} Output MUST be valid JSON format: {items:[{url,score}]}`, 
        JSON.stringify(pending.map(p => ({ t: p.title, u: p.link })))
      );
      
      const jsonMatch = filterRes.match(/\{.*\}/s);
      const scores = JSON.parse(jsonMatch ? jsonMatch[0] : filterRes).items || [];
      targets = pending.filter(p => {
        const scoreObj = scores.find(s => s.url === p.link);
        return (scoreObj?.score || 0) >= settings.score_threshold;
      });
      console.log(`Filtered: ${pending.length} -> ${targets.length} articles`);
    } catch (e) {
      logError("FILTER_LOGIC", "Filtering failed, proceeding with all pending articles", e.message);
    }
  }

  // 4. 各記事の解析・チェーン実行
  const apiOutput = [];
  for (const article of targets) {
    try {
      console.log(`\n>> Processing: ${article.title}`);
      
      // スクレイピング処理
      let bodyText = "";
      try {
        const res = await fetch(article.link, { 
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, 
          signal: AbortSignal.timeout(10000) 
        });
        const html = await res.text();
        const doc = new JSDOM(html, { url: article.link });
        const reader = new Readability(doc.window.document);
        const parsed = reader.parse();
        bodyText = parsed?.textContent.trim().substring(0, 10000) || "";
      } catch (e) {
        logError("SCRAPING", article.title, "Fallback to snippet");
      }

      const finalContent = bodyText || article.contentSnippet || article.content || "N/A";

      // 重複検知（セマンティック検索）
      const emb = await openai.embeddings.create({ 
        model: settings.embedding_model, 
        input: article.title 
      });
      const vec = emb.data[0].embedding;
      const isDuplicate = vectorDb.some(v => 
        cosineSimilarity(vec, v.vec) > (settings.similarity_threshold || 0.85)
      );
      
      if (isDuplicate) {
        console.log(`   Skipped: Similar content already exists.`);
        continue;
      }

      // ワークフロー（エージェント・チェーン）実行
      let currentContext = `Title: ${article.title}\nContent: ${finalContent}`;
      
      for (const step of config.workflow) {
        if (!step.enabled || step.id === 'filter') continue;
        console.log(`   Agent: [${step.id}] Using Model: ${step.model}`);
        currentContext = await askAI(step.model, step.prompt, currentContext);
      }

      // 結果の保存用配列へ追加
      const resultEntry = {
        title: article.title,
        link: article.link,
        analysis: currentContext,
        date: new Date().toISOString()
      };
      
      apiOutput.push(resultEntry);
      db.push({ link: article.link, date: new Date().toISOString() });
      vectorDb.push({ link: article.link, vec });

    } catch (e) {
      logError("CHAIN_EXECUTION", article.title, e.message);
    }
  }

  // 5. 結果のアップロードと永続化
  if (apiOutput.length > 0) {
    console.log(`\n--- Uploading ${apiOutput.length} results to R2 ---`);
    await r2.upload('api_output.json', JSON.stringify(apiOutput, null, 2), 'application/json');
    
    // DBの肥大化防止（最新件数に絞り込み）
    await r2.upload('articles_db.json', JSON.stringify(db.slice(-1000)), 'application/json');
    await r2.upload('vectors.json', JSON.stringify(vectorDb.slice(-500)), 'application/json');
  }

  await saveLogs(errorLogs);
  console.log("=== SUCCESS: Process Completed ===");
}

/**
 * ログの保存処理
 */
async function saveLogs(logs) {
  if (logs.length === 0) return;
  try {
    const existingLogs = JSON.parse(await r2.download('error_log.json') || "[]");
    const mergedLogs = [...logs, ...existingLogs].slice(0, 100);
    await r2.upload('error_log.json', JSON.stringify(mergedLogs, null, 2), 'application/json');
  } catch (e) {
    console.error("Failed to save error logs:", e);
  }
}

// 実行
run().catch(err => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
