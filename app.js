require('dotenv').config();
const OpenAI = require("openai");
const Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const r2 = require('./lib/r2');
const { cosineSimilarity } = require('./lib/utils');

async function run() {
  const config = JSON.parse(await r2.download('prompts.json'));
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const parser = new Parser();
  const settings = config.settings;

  // 1. RSS巡回 & 期間フィルタリング
  let allItems = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (settings.fetch_days || 3));

  for (const url of config.rss_feeds) {
    const feed = await parser.parseURL(url).catch(() => ({ items: [] }));
    const filtered = feed.items.filter(i => new Date(i.pubDate) > cutoff);
    allItems.push(...filtered);
  }

  const db = JSON.parse(await r2.download('articles_db.json') || "[]");
  const vectorDb = JSON.parse(await r2.download('vectors.json') || "[]");
  const pending = allItems.filter(i => !db.some(d => d.link === i.link));

  if (pending.length === 0) return console.log("No news.");

  // 2. スコアリングフィルタリング
  const filterStep = config.workflow.find(s => s.id === 'filter' && s.enabled);
  let targets = pending;
  if (filterStep) {
    const res = await openai.chat.completions.create({
      model: filterStep.model,
      messages: [{ role: "developer", content: filterStep.prompt }, { role: "user", content: JSON.stringify(pending.map(p => ({ t: p.title, u: p.link }))) }],
      response_format: { type: "json_object" }
    });
    const scores = JSON.parse(res.choices[0].message.content).items || [];
    targets = pending.filter(p => (scores.find(s => s.url === p.link)?.score || 0) >= settings.score_threshold);
  }

  const apiOutput = [];
  for (const article of targets) {
    try {
      // 全文取得
      const page = await fetch(article.link, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const doc = new JSDOM(await page.text(), { url: article.link });
      const fullText = (new Readability(doc.window.document)).parse()?.textContent.trim().substring(0, 8000);
      if (!fullText) continue;

      // ベクトル重複チェック
      const emb = await openai.embeddings.create({ model: settings.embedding_model, input: article.title });
      const vec = emb.data[0].embedding;
      if (vectorDb.some(v => cosineSimilarity(vec, v.vec) > settings.similarity_threshold)) continue;

      // パイプライン実行
      let currentData = `Article: ${fullText}`;
      for (const step of config.workflow) {
        if (!step.enabled || step.id === 'filter') continue;
        const aiRes = await openai.chat.completions.create({
          model: step.model,
          messages: [{ role: "developer", content: step.prompt }, { role: "user", content: currentData }]
        });
        currentData = aiRes.choices[0].message.content;
      }

      apiOutput.push({ title: article.title, link: article.link, analysis: currentData });
      db.push({ link: article.link, date: new Date().toISOString() });
      vectorDb.push({ link: article.link, vec });
    } catch (e) { console.error(e); }
  }

  if (apiOutput.length > 0) {
    await r2.upload('api_output.json', JSON.stringify(apiOutput), 'application/json');
    await r2.upload('articles_db.json', JSON.stringify(db.slice(-1000)), 'application/json');
    await r2.upload('vectors.json', JSON.stringify(vectorDb.slice(-500)), 'application/json');
  }
}
run().catch(console.error);
