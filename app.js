require('dotenv').config();
const OpenAI = require("openai");
const Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const r2 = require('./lib/r2');
const { cosineSimilarity } = require('./lib/utils');

async function run() {
  console.log("=== START: Intelligence Cycle ===");
  
  const config = JSON.parse(await r2.download('prompts.json'));
  if (!config) throw new Error("!! ERROR: prompts.json が見つかりません。");
  
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const parser = new Parser();
  const settings = config.settings;

  console.log("--- 1. RSSフィードを取得中 ---");
  let allItems = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (settings.fetch_days || 3));

  for (const url of config.rss_feeds) {
    try {
      const feed = await parser.parseURL(url);
      const filtered = feed.items.filter(i => new Date(i.pubDate) > cutoff);
      allItems.push(...filtered);
    } catch (e) {
      console.error(`取得失敗: ${url}`);
    }
  }

  const db = JSON.parse(await r2.download('articles_db.json') || "[]");
  const vectorDb = JSON.parse(await r2.download('vectors.json') || "[]");
  const pending = allItems.filter(i => !db.some(d => d.link === i.link));

  if (pending.length === 0) return console.log("=== FINISH: 新着なし ===");

  // --- フィルタリング ---
  console.log("--- 2. スコアリング実行中 ---");
  const filterStep = config.workflow.find(s => s.id === 'filter' && s.enabled);
  let targets = pending;

  if (filterStep) {
    const res = await openai.chat.completions.create({
      model: filterStep.model,
      messages: [
        { role: "system", content: filterStep.prompt + " Output MUST be JSON." },
        { role: "user", content: JSON.stringify(pending.map(p => ({ t: p.title, u: p.link }))) }
      ],
      response_format: { type: "json_object" }
    });
    const scores = JSON.parse(res.choices[0].message.content).items || [];
    targets = pending.filter(p => (scores.find(s => s.url === p.link)?.score || 0) >= settings.score_threshold);
    
    // ログ出力
    scores.forEach(s => {
      const p = pending.find(item => item.link === s.url);
      if (p) console.log(`[${s.score}点] ${s.score >= settings.score_threshold ? "✅" : "❌"} ${p.title}`);
    });
  }

  // --- 保存処理 ---
  const apiOutput = [];
  for (const article of targets) {
    try {
      console.log(`\n>> 処理中: ${article.title}`);
      
      let fullText = "";
      try {
        const page = await fetch(article.link, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
        const html = await page.text();
        const doc = new JSDOM(html, { url: article.link });
        fullText = (new Readability(doc.window.document)).parse()?.textContent.trim().substring(0, 8000) || "";
      } catch (e) {
        console.log("   ⚠️ 本文取得エラー（スキップせずタイトルのみで続行）");
      }

      // 重複チェック
      const emb = await openai.embeddings.create({ model: settings.embedding_model, input: article.title });
      const vec = emb.data[0].embedding;
      if (vectorDb.some(v => cosineSimilarity(vec, v.vec) > settings.similarity_threshold)) {
        console.log("   !! SKIP: 重複判定");
        continue;
      }

      // 分析エージェントの実行
      let analysisResult = "";
      if (fullText) {
        let currentContent = `Title: ${article.title}\nContent: ${fullText}`;
        for (const step of config.workflow) {
          if (!step.enabled || step.id === 'filter') continue;
          const aiRes = await openai.chat.completions.create({
            model: step.model,
            messages: [{ role: "system", content: step.prompt }, { role: "user", content: currentContent }]
          });
          currentContent = aiRes.choices[0].message.content;
        }
        analysisResult = currentContent;
      } else {
        // 本文が取れなかった時のフォールバック
        analysisResult = "※本文の抽出に失敗しました。リンク先を直接確認してください。";
      }

      apiOutput.push({
        title: article.title,
        link: article.link,
        date: article.pubDate,
        analysis: analysisResult
      });
      
      db.push({ link: article.link, date: new Date().toISOString() });
      vectorDb.push({ link: article.link, vec });
      console.log("<< 完了");

    } catch (e) {
      console.error(`!! ERROR: ${article.title} - ${e.message}`);
    }
  }

  // R2へ書き込み（常に実行）
  if (apiOutput.length > 0) {
    console.log("\n--- 3. R2に保存中 ---");
    await r2.upload('api_output.json', JSON.stringify(apiOutput), 'application/json');
    await r2.upload('articles_db.json', JSON.stringify(db.slice(-1000)), 'application/json');
    await r2.upload('vectors.json', JSON.stringify(vectorDb.slice(-500)), 'application/json');
    console.log("=== ALL SUCCESS ===");
  } else {
    console.log("=== FINISH: 保存対象なし ===");
  }
}

run().catch(e => console.error("!! CRITICAL !!", e));
