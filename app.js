require('dotenv').config();
const OpenAI = require("openai");
const { Anthropic } = require("@anthropic-ai/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const r2 = require('./lib/r2');
const { cosineSimilarity } = require('./lib/utils');

async function run() {
  console.log("=== START: Multi-Provider Orchestrator ===");

  // --- デバッグ用：APIキーがプログラムまで届いているかの確認 ---
  console.log("--- DEBUG: API KEYS CHECK ---");
  console.log("Gemini Key Length: ", process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.length : "UNDEFINED");
  console.log("OpenAI Key exists: ", !!process.env.OPENAI_API_KEY);
  console.log("Anthropic Key exists: ", !!process.env.ANTHROPIC_API_KEY);
  console.log("-----------------------------");

  // --- ログ管理用変数の初期化 ---
  const errorLogs = [];
  const processLogs = []; // 全件の推移を記録するログ

  const logError = (context, message, details = null) => {
    errorLogs.push({ time: new Date().toLocaleString('ja-JP'), context, message, details });
    // 修正: 隠れていたエラー詳細(details)をGitHub Actionsの画面上でも表示するようにしました
    console.error(`[${context}] ${message} ${details ? '| Details: ' + details : ''}`);
  };

  const logProcess = (title, url, status, detail) => {
    processLogs.push({
      time: new Date().toLocaleString('ja-JP'),
      title,
      url,
      status, // 'SUCCESS', 'FILTERED', 'SKIPPED', 'ERROR'
      detail
    });
    console.log(`[${status}] ${title} - ${detail}`);
  };

  // 設定の読み込み
  const configStr = await r2.download('prompts.json');
  if (!configStr) throw new Error("prompts.json missing.");
  const config = JSON.parse(configStr);
  const settings = config.settings;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  // GoogleGenerativeAI の初期化 (ここでキーが空だと即エラーになるのを防ぎます)
  const googleAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

  // AIへの問い合わせ共通関数
  const askAI = async (model, systemPrompt, userContent) => {
    const m = model.toLowerCase();
    if (m.includes('gpt') || m.startsWith('o1') || m.startsWith('o3')) {
      const res = await openai.chat.completions.create({
        model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }]
      });
      return res.choices[0].message.content;
    } 
    else if (m.includes('claude')) {
      const res = await anthropic.messages.create({
        model, max_tokens: 4096, system: systemPrompt,
        messages: [{ role: "user", content: userContent }]
      });
      return res.content[0].text;
    } 
    else if (m.includes('gemini')) {
      const genModel = googleAI.getGenerativeModel({ model });
      const res = await genModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: `System Instruction: ${systemPrompt}\n\nUser: ${userContent}` }] }]
      });
      return res.response.text();
    }
    throw new Error(`Unknown provider for model: ${model}`);
  };

  // RSSフィードの取得
  let allItems = [];
  const parser = new Parser();
  const cutoff = new Date();
  const daysLimit = settings.fetch_days || 3;
  cutoff.setDate(cutoff.getDate() - daysLimit);
  
  for (const feedConfig of config.rss_feeds) {
    const url = feedConfig.url || feedConfig;
    try {
      const feed = await parser.parseURL(url);
      allItems.push(...feed.items.filter(i => new Date(i.pubDate) > cutoff));
    } catch (e) { logError("RSS", url, e.message); }
  }

  const db = JSON.parse(await r2.download('articles_db.json') || "[]");
  const vectorDb = JSON.parse(await r2.download('vectors.json') || "[]");
  const pending = allItems.filter(i => !db.some(d => d.link === i.link));

  if (pending.length === 0) {
    console.log("No new articles.");
    await saveActivityLogs(errorLogs, processLogs);
    return;
  }

  let targets = pending;

  // --- 1. Collection Scope: チャンク化して一括判定 ---
  const collectionSteps = config.workflow.filter(s => s.enabled && s.scope === 'collection');
  const CHUNK_SIZE = settings.chunk_size || 20;

  for (const step of collectionSteps) {
    try {
      console.log(`\n>> Batch Processing: [${step.id}]`);
      let allScoredItems = [];

      for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
        const chunk = targets.slice(i, i + CHUNK_SIZE);
        try {
          const batchRes = await askAI(
            step.model, 
            step.prompt + " Output MUST be JSON format: {items:[{url,score}]}", 
            JSON.stringify(chunk.map(p => ({ t: p.title, u: p.link })))
          );
          const jsonMatch = batchRes.match(/\{.*\}/s);
          const chunkScores = JSON.parse(jsonMatch ? jsonMatch[0] : batchRes).items || [];
          allScoredItems.push(...chunkScores);
        } catch (e) {
          logError("CollectionChunk", step.id, e.message);
        }
      }

      // フィルタリングとログ記録
      targets = targets.filter(p => {
        const scored = allScoredItems.find(s => s.url === p.link);
        const score = scored?.score || 0;
        const passed = score >= settings.score_threshold;
        if (!passed) {
          logProcess(p.title, p.link, 'FILTERED', `Batch Score: ${score} (Threshold: ${settings.score_threshold})`);
        }
        return passed;
      });
    } catch (e) { logError("CollectionStep", step.id, e.message); }
  }

  // --- 2. Item Scope: 記事ごとの個別処理 ---
  const apiOutput = [];
  const nowStr = new Date().toISOString();

  for (const article of targets) {
    try {
      // スクレイピング
      let bodyText = "";
      try {
        const res = await fetch(article.link, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        const html = await res.text();
        const doc = new JSDOM(html, { url: article.link });
        bodyText = (new Readability(doc.window.document)).parse()?.textContent.trim().substring(0, 10000) || "";
      } catch (e) { logError("Scraping", article.title, "Fallback to snippet"); }

      const finalContent = bodyText || article.contentSnippet || article.content || "N/A";

      // ベクトルによる重複チェック
      const emb = await openai.embeddings.create({ model: settings.embedding_model, input: article.title });
      const vec = emb.data[0].embedding;
      const simMatch = vectorDb.find(v => cosineSimilarity(vec, v.vec) > (settings.similarity_threshold || 0.85));
      if (simMatch) {
        logProcess(article.title, article.link, 'SKIPPED', `High similarity with: ${simMatch.link}`);
        continue;
      }

      // ワークフロー（エージェント・チェイン）の実行
      let currentContext = `Title: ${article.title}\nContent: ${finalContent}`;
      let shouldSkip = false;
      let skipReason = "";

      for (const step of config.workflow) {
        if (!step.enabled || step.scope !== 'item') continue;

        // キーワード・項目フィルタ判定
        if (step.type === 'filter') {
          try {
            const jsonMatch = currentContext.match(/\{.*\}/s);
            const data = JSON.parse(jsonMatch ? jsonMatch[0] : currentContext);
            const targetValue = String(data[step.target_key] || "").toLowerCase();
            const matchType = step.match_type || "partial";

            const checkMatch = (list, val) => {
              if (!list || !Array.isArray(list)) return false;
              return list.some(kw => matchType === 'exact' ? val === kw.toLowerCase() : val.includes(kw.toLowerCase()));
            };

            if (step.exclude && checkMatch(step.exclude, targetValue)) {
              shouldSkip = true;
              skipReason = `Excluded keyword in ${step.target_key}`;
              break;
            }
            if (step.include && step.include.length > 0 && !checkMatch(step.include, targetValue)) {
              shouldSkip = true;
              skipReason = `Required keyword not found in ${step.target_key}`;
              break;
            }
          } catch (e) {
            console.warn(`Filter Error: ${e.message}`);
          }
          continue; 
        }

        currentContext = await askAI(step.model, step.prompt, currentContext);
      }

      if (shouldSkip) {
        logProcess(article.title, article.link, 'FILTERED', skipReason);
        continue;
      }

      // 成功の記録
      logProcess(article.title, article.link, 'SUCCESS', 'Fully processed and analyzed');
      apiOutput.push({ title: article.title, link: article.link, analysis: currentContext, date: nowStr });
      db.push({ link: article.link, date: nowStr });
      vectorDb.push({ link: article.link, vec, date: nowStr });

    } catch (e) { 
      logError("Chain", article.title, e.message);
      logProcess(article.title, article.link, 'ERROR', e.message);
    }
  }

  // --- 3. データの保存と期限管理 ---
  const retentionCutoff = new Date(new Date().getTime() - (daysLimit * 24 * 60 * 60 * 1000));
  const updateAndUpload = async (filename, newData, oldData) => {
    const merged = [...newData, ...oldData].filter(item => item.date && new Date(item.date) > retentionCutoff);
    await r2.upload(filename, JSON.stringify(merged, null, 2), 'application/json');
  };

  if (apiOutput.length > 0 || processLogs.length > 0) {
    const oldOutput = JSON.parse(await r2.download('api_output.json') || "[]");
    await updateAndUpload('api_output.json', apiOutput, oldOutput);
    await r2.upload('articles_db.json', JSON.stringify(db.filter(d => new Date(d.date) > retentionCutoff)), 'application/json');
    await r2.upload('vectors.json', JSON.stringify(vectorDb.filter(v => v.date && new Date(v.date) > retentionCutoff)), 'application/json');
  }

  await saveActivityLogs(errorLogs, processLogs);
  console.log("=== SUCCESS ===");
}

async function saveActivityLogs(errors, processes) {
  try {
    const oldErrors = JSON.parse(await r2.download('error_log.json') || "[]");
    await r2.upload('error_log.json', JSON.stringify([...errors, ...oldErrors].slice(0, 100), null, 2), 'application/json');

    const oldProcesses = JSON.parse(await r2.download('process_log.json') || "[]");
    await r2.upload('process_log.json', JSON.stringify([...processes, ...oldProcesses].slice(0, 200), null, 2), 'application/json');
  } catch (e) { console.error("Log saving failed:", e); }
}

run().catch(console.error);
