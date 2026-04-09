require('dotenv').config();
const OpenAI = require("openai");
const Parser = require('rss-parser');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const r2 = require('./lib/r2');
const { cosineSimilarity } = require('./lib/utils');

async function run() {
  console.log("=== START: Intelligence Cycle ===");
  
  // 1. 設定の読み込み
  const config = JSON.parse(await r2.download('prompts.json'));
  if (!config) throw new Error("!! CRITICAL ERROR: prompts.json が R2 に見つかりません。");
  
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const parser = new Parser();
  const settings = config.settings;

  // 2. RSSフィードの取得
  console.log("--- 1. RSSフィードを取得中 ---");
  let allItems = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (settings.fetch_days || 3));

  for (const url of config.rss_feeds) {
    try {
      const feed = await parser.parseURL(url);
      const filtered = feed.items.filter(i => new Date(i.pubDate) > cutoff);
      allItems.push(...filtered);
      console.log(`取得成功 (${filtered.length}件): ${url}`);
    } catch (e) {
      console.error(`取得失敗: ${url} - ${e.message}`);
    }
  }

  // 3. 履歴の読み込みと重複排除
  const db = JSON.parse(await r2.download('articles_db.json') || "[]");
  const vectorDb = JSON.parse(await r2.download('vectors.json') || "[]");
  const pending = allItems.filter(i => !db.some(d => d.link === i.link));

  console.log(`未処理の記事: ${pending.length} 件`);
  if (pending.length === 0) {
    console.log("=== FINISH: 新着記事なし ===");
    return;
  }

  // 4. フィルタリングとスコアリングのログ出力
  console.log("--- 2. フィルタリング（AIスコアリング）を実行中 ---");
  const filterStep = config.workflow.find(s => s.id === 'filter' && s.enabled);
  let targets = pending;

  if (filterStep) {
    const res = await openai.chat.completions.create({
      model: filterStep.model,
      messages: [
        { role: "system", content: filterStep.prompt + " Output MUST be valid JSON format." },
        { role: "user", content: JSON.stringify(pending.map(p => ({ t: p.title, u: p.link }))) }
      ],
      response_format: { type: "json_object" }
    });

    const parsedRes = JSON.parse(res.choices[0].message.content);
    const scores = parsedRes.items || [];

    console.log("--- [スコアリング結果の詳細] ---");
    scores.forEach(s => {
      const article = pending.find(p => p.link === s.url);
      const title = article ? article.title : "不明なタイトル";
      const isPassed = s.score >= settings.score_threshold;
      const statusIcon = isPassed ? "✅ [採用]" : "❌ [却下]";
      console.log(`${statusIcon} スコア: ${s.score}点 / 基準: ${settings.score_threshold}点 | ${title}`);
    });
    console.log("-------------------------------");

    targets = pending.filter(p => {
      const s = scores.find(scoreObj => scoreObj.url === p.link);
      return (s?.score || 0) >= settings.score_threshold;
    });
  }

  console.log(`分析対象として確定した記事: ${targets.length} 件`);

  // 5. 本文抽出と詳細分析
  const apiOutput = [];
  for (const article of targets) {
    try {
      console.log(`\n>> 分析開始: ${article.title}`);
      
      const page = await fetch(article.link, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await page.text();
      const doc = new JSDOM(html, { url: article.link });
      const reader = new Readability(doc.window.document);
      const articleData = reader.parse();
      const fullText = articleData?.textContent.trim().substring(0, 8000);
      
      if (!fullText) {
        console.log("   !! SKIP: 本文の抽出に失敗しました。");
        continue;
      }

      // 重複検知（ベクトル類似度）
      const emb = await openai.embeddings.create({ model: settings.embedding_model, input: article.title });
      const vec = emb.data[0].embedding;
      const isDuplicate = vectorDb.some(v => cosineSimilarity(vec, v.vec) > settings.similarity_threshold);
      
      if (isDuplicate) {
        console.log("   !! SKIP: すでに類似した内容の記事を処理済みです。");
        continue;
      }

      // ワークフロー（分析エージェント）の実行
      let currentContent = `Title: ${article.title}\nContent: ${fullText}`;
      for (const step of config.workflow) {
        if (!step.enabled || step.id === 'filter') continue;
        console.log(`   エージェント [${step.id}] が思考中...`);
        const aiRes = await openai.chat.completions.create({
          model: step.model,
          messages: [
            { role: "system", content: step.prompt },
            { role: "user", content: currentContent }
          ]
        });
        currentContent = aiRes.choices[0].message.content;
      }

      apiOutput.push({ title: article.title, link: article.link, analysis: currentContent });
      db.push({ link: article.link, date: new Date().toISOString() });
      vectorDb.push({ link: article.link, vec });
      console.log("<< 分析完了");

    } catch (e) {
      console.error(`!! ERROR: ${article.title} の処理中に例外が発生: ${e.message}`);
    }
  }

  // 6. R2への保存
  if (apiOutput.length > 0) {
    console.log("\n--- 3. 分析結果をR2に書き込み中 ---");
    await r2.upload('api_output.json', JSON.stringify(apiOutput), 'application/json');
    await r2.upload('articles_db.json', JSON.stringify(db.slice(-1000)), 'application/json');
    await r2.upload('vectors.json', JSON.stringify(vectorDb.slice(-500)), 'application/json');
    console.log("=== ALL SUCCESS: 全データが正常に保存されました ===");
  } else {
    console.log("\n=== FINISH: 保存すべき新しい分析結果はありませんでした ===");
  }
}

run().catch(e => console.error("!! CRITICAL ERROR !!", e));
