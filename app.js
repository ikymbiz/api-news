require('dotenv').config();
const OpenAI = require("openai");
const Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const r2 = require('./lib/r2');
const { cosineSimilarity } = require('./lib/utils');

async function run() {
  console.log("=== START: Orchestrator Loop ===");
  const errorLogs = [];
  const logError = (context, message, details = null) => {
    errorLogs.push({ 
      time: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }), 
      context, message, details 
    });
    console.error(`[${context}] ${message}`);
  };

  const configStr = await r2.download('prompts.json');
  if (!configStr) {
    logError("Config", "prompts.json not found on R2.");
    await saveLogs(errorLogs);
    return;
  }
  
  const config = JSON.parse(configStr);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const parser = new Parser();
  const settings = config.settings;

  let allItems = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (settings.fetch_days || 3));
  
  for (const url of config.rss_feeds) {
    try {
      const feed = await parser.parseURL(url);
      allItems.push(...feed.items.filter(i => new Date(i.pubDate) > cutoff));
    } catch (e) { logError("RSS_Fetch", url, e.message); }
  }

  const db = JSON.parse(await r2.download('articles_db.json') || "[]");
  const vectorDb = JSON.parse(await r2.download('vectors.json') || "[]");
  const pending = allItems.filter(i => !db.some(d => d.link === i.link));

  if (pending.length === 0) {
    console.log("No new articles.");
    await saveLogs(errorLogs);
    return;
  }

  const filterStep = config.workflow.find(s => s.id === 'filter' && s.enabled);
  let targets = pending;
  if (filterStep) {
    try {
      const res = await openai.chat.completions.create({
        model: filterStep.model, // フィルタ用モデル
        messages: [
          { role: "system", content: filterStep.prompt + " Output JSON: {items:[{url,score}]}" },
          { role: "user", content: JSON.stringify(pending.map(p => ({ t: p.title, u: p.link }))) }
        ],
        response_format: { type: "json_object" }
      });
      const scores = JSON.parse(res.choices[0].message.content).items || [];
      targets = pending.filter(p => (scores.find(s => s.url === p.link)?.score || 0) >= settings.score_threshold);
    } catch (e) { logError("Filter", "AI Error", e.message); }
  }

  const apiOutput = [];
  for (const article of targets) {
    try {
      let bodyText = "";
      try {
        const res = await fetch(article.link, { 
          headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
          signal: AbortSignal.timeout(15000)
        });
        const html = await res.text();
        const doc = new JSDOM(html, { url: article.link });
        bodyText = (new Readability(doc.window.document)).parse()?.textContent.trim().substring(0, 10000) || "";
      } catch (e) { logError("Scraping", article.title, "Using Snippet."); }

      const finalContent = bodyText || article.contentSnippet || article.content || "N/A";
      const emb = await openai.embeddings.create({ model: settings.embedding_model, input: article.title });
      const vec = emb.data[0].embedding;
      if (vectorDb.some(v => cosineSimilarity(vec, v.vec) > (settings.similarity_threshold || 0.85))) continue;

      let currentContext = `Title: ${article.title}\nContent: ${finalContent}`;
      
      // 各エージェント（ワークフローのステップ）を個別のモデル設定で実行
      for (const step of config.workflow) {
        if (!step.enabled || step.id === 'filter') continue;
        console.log(`   Step: [${step.id}] Model: ${step.model}`);
        const aiRes = await openai.chat.completions.create({
          model: step.model, // ここでエージェントごとのモデル設定を使用
          messages: [{ role: "system", content: step.prompt }, { role: "user", content: currentContext }]
        });
        currentContext = aiRes.choices[0].message.content;
      }

      apiOutput.push({ title: article.title, link: article.link, analysis: currentContext, date: new Date().toISOString() });
      db.push({ link: article.link, date: new Date().toISOString() });
      vectorDb.push({ link: article.link, vec });
    } catch (e) { logError("Chain", article.title, e.message); }
  }

  if (apiOutput.length > 0) {
    await r2.upload('api_output.json', JSON.stringify(apiOutput, null, 2), 'application/json');
    await r2.upload('articles_db.json', JSON.stringify(db.slice(-1000)), 'application/json');
    await r2.upload('vectors.json', JSON.stringify(vectorDb.slice(-500)), 'application/json');
  }
  await saveLogs(errorLogs);
}

async function saveLogs(logs) {
  try {
    const old = JSON.parse(await r2.download('error_log.json') || "[]");
    await r2.upload('error_log.json', JSON.stringify([...logs, ...old].slice(0, 100), null, 2), 'application/json');
  } catch (e) { console.error("Log upload failed", e); }
}

run().catch(console.error);
