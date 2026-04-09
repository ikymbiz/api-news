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
  const errorLogs = [];
  const logError = (context, message, details = null) => {
    errorLogs.push({ time: new Date().toLocaleString('ja-JP'), context, message, details });
    console.error(`[${context}] ${message}`);
  };

  // 設定の読み込み
  const configStr = await r2.download('prompts.json');
  if (!configStr) throw new Error("prompts.json missing.");
  const config = JSON.parse(configStr);
  const settings = config.settings;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const googleAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

  if (pending.length === 0) return console.log("No new articles.");

  let targets = pending;

  // --- 1. Collection Scope: チャンク化して一括判定 ---
  const collectionSteps = config.workflow.filter(s => s.enabled && s.scope === 'collection');
  const CHUNK_SIZE = settings.chunk_size || 20;

  for (const step of collectionSteps) {
    try {
      console.log(`\n>> Batch Processing: [${step.id}] Model: ${step.model}`);
      let allScoredItems = [];

      for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
        const chunk = targets.slice(i, i + CHUNK_SIZE);
        console.log(`   Processing chunk: ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(targets.length / CHUNK_SIZE)} (${chunk.length} items)`);

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
          logError("CollectionChunk", step.id, `Chunk starting at ${i}: ${e.message}`);
        }
      }

      targets = targets.filter(p => {
        const scored = allScoredItems.find(s => s.url === p.link);
        return (scored?.score || 0) >= settings.score_threshold;
      });
      console.log(`>> Filtered: ${targets.length} articles remaining after [${step.id}].`);
    } catch (e) { logError("CollectionStep", step.id, e.message); }
  }

  // --- 2. Item Scope: 記事ごとの個別処理 ---
  const apiOutput = [];
  const nowStr = new Date().toISOString();

  for (const article of targets) {
    try {
      console.log(`\n>> Analyzing: ${article.title}`);
      
      // スクレイピング
      let bodyText = "";
      try {
        const res = await fetch(article.link, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        const html = await res.text();
        const doc = new JSDOM(html, { url: article.link });
        bodyText = (new Readability(doc.window.document)).parse()?.textContent.trim().substring(0, 10000) || "";
      } catch (e) { logError("Scraping", article.title, "Snippet Fallback"); }

      const finalContent = bodyText || article.contentSnippet || article.content || "N/A";

      // ベクトルによる重複チェック
      const emb = await openai.embeddings.create({ model: settings.embedding_model, input: article.title });
      const vec = emb.data[0].embedding;
      if (vectorDb.some(v => cosineSimilarity(vec, v.vec) > (settings.similarity_threshold || 0.85))) {
        console.log("   Skipped: High similarity detected.");
        continue;
      }

      // ワークフロー（エージェント・チェイン）の実行
      let currentContext = `Title: ${article.title}\nContent: ${finalContent}`;
      for (const step of config.workflow) {
        if (!step.enabled || step.scope !== 'item') continue;
        console.log(`   Agent: [${step.id}] Model: ${step.model}`);
        currentContext = await askAI(step.model, step.prompt, currentContext);
      }

      // 結果の蓄積
      apiOutput.push({ title: article.title, link: article.link, analysis: currentContext, date: nowStr });
      db.push({ link: article.link, date: nowStr });
      vectorDb.push({ link: article.link, vec, date: nowStr });
    } catch (e) { logError("Chain", article.title, e.message); }
  }

  // --- 3. データの保存と期限管理 (3日間保持) ---
  const retentionCutoff = new Date(new Date().getTime() - (daysLimit * 24 * 60 * 60 * 1000));

  const updateAndUpload = async (filename, newData, oldData) => {
    const merged = [...newData, ...oldData]
      .filter(item => item.date && new Date(item.date) > retentionCutoff);
    await r2.upload(filename, JSON.stringify(merged, null, 2), 'application/json');
  };

  if (apiOutput.length > 0 || targets.length > 0) {
    // API出力
    const oldOutput = JSON.parse(await r2.download('api_output.json') || "[]");
    await updateAndUpload('api_output.json', apiOutput, oldOutput);

    // URL DB
    await r2.upload('articles_db.json', JSON.stringify(db.filter(d => new Date(d.date) > retentionCutoff)), 'application/json');

    // Vector DB
    await r2.upload('vectors.json', JSON.stringify(vectorDb.filter(v => v.date && new Date(v.date) > retentionCutoff)), 'application/json');
  }

  await saveLogs(errorLogs);
  console.log("=== SUCCESS ===");
}

async function saveLogs(logs) {
  try {
    const old = JSON.parse(await r2.download('error_log.json') || "[]");
    const mergedLogs = [...logs, ...old].slice(0, 100);
    await r2.upload('error_log.json', JSON.stringify(mergedLogs, null, 2), 'application/json');
  } catch (e) { console.error(e); }
}

run().catch(console.error);
