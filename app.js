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

  // r2.download 内部で process.env.R2_BUCKET_NAME を参照するように実装してください
  const configStr = await r2.download('prompts.json');
  if (!configStr) throw new Error("prompts.json missing.");
  const config = JSON.parse(configStr);
  const settings = config.settings;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const googleAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const askAI = async (model, systemPrompt, userContent) => {
    if (model.startsWith('gpt') || model.startsWith('o3')) {
      const res = await openai.chat.completions.create({
        model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }]
      });
      return res.choices[0].message.content;
    } 
    else if (model.startsWith('claude')) {
      const res = await anthropic.messages.create({
        model, max_tokens: 4096, system: systemPrompt,
        messages: [{ role: "user", content: userContent }]
      });
      return res.content[0].text;
    } 
    else if (model.startsWith('gemini')) {
      const genModel = googleAI.getGenerativeModel({ model });
      const res = await genModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: `System Instruction: ${systemPrompt}\n\nUser: ${userContent}` }] }]
      });
      return res.response.text();
    }
    throw new Error(`Unknown model: ${model}`);
  };

  let allItems = [];
  const parser = new Parser();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (settings.fetch_days || 3));
  for (const url of config.rss_feeds) {
    try {
      const feed = await parser.parseURL(url);
      allItems.push(...feed.items.filter(i => new Date(i.pubDate) > cutoff));
    } catch (e) { logError("RSS", url, e.message); }
  }

  const db = JSON.parse(await r2.download('articles_db.json') || "[]");
  const vectorDb = JSON.parse(await r2.download('vectors.json') || "[]");
  const pending = allItems.filter(i => !db.some(d => d.link === i.link));

  if (pending.length === 0) return console.log("No new articles.");

  const filterStep = config.workflow.find(s => s.id === 'filter' && s.enabled);
  let targets = pending;
  if (filterStep) {
    try {
      const filterRes = await askAI(filterStep.model, filterStep.prompt + " Output MUST be JSON format: {items:[{url,score}]}", JSON.stringify(pending.map(p => ({ t: p.title, u: p.link }))));
      const jsonMatch = filterRes.match(/\{.*\}/s);
      const scores = JSON.parse(jsonMatch ? jsonMatch[0] : filterRes).items || [];
      targets = pending.filter(p => (scores.find(s => s.url === p.link)?.score || 0) >= settings.score_threshold);
    } catch (e) { logError("Filter", "Error", e.message); }
  }

  const apiOutput = [];
  for (const article of targets) {
    try {
      console.log(`\n>> Analyzing: ${article.title}`);
      let bodyText = "";
      try {
        const res = await fetch(article.link, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        const html = await res.text();
        const doc = new JSDOM(html, { url: article.link });
        bodyText = (new Readability(doc.window.document)).parse()?.textContent.trim().substring(0, 10000) || "";
      } catch (e) { logError("Scraping", article.title, "Snippet Fallback"); }

      const finalContent = bodyText || article.contentSnippet || article.content || "N/A";
      const emb = await openai.embeddings.create({ model: settings.embedding_model, input: article.title });
      const vec = emb.data[0].embedding;
      if (vectorDb.some(v => cosineSimilarity(vec, v.vec) > (settings.similarity_threshold || 0.85))) continue;

      let currentContext = `Title: ${article.title}\nContent: ${finalContent}`;
      for (const step of config.workflow) {
        if (!step.enabled || step.id === 'filter') continue;
        console.log(`   Agent: [${step.id}] Model: ${step.model}`);
        currentContext = await askAI(step.model, step.prompt, currentContext);
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
  console.log("=== SUCCESS ===");
}

async function saveLogs(logs) {
  try {
    const old = JSON.parse(await r2.download('error_log.json') || "[]");
    await r2.upload('error_log.json', JSON.stringify([...logs, ...old].slice(0, 100), null, 2), 'application/json');
  } catch (e) { console.error(e); }
}

run().catch(console.error);
