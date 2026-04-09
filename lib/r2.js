const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { retry } = require("./utils");

// 環境変数のチェック（デバッグ用：値そのものは表示されません）
if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  console.error("[R2 Setup] Warning: One or more R2 environment variables are missing.");
}

const s3 = new S3Client({
  region: "auto",
  // ポイント: ACCOUNT_IDに https:// などが含まれているとここでエラーになります
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// バケット名も環境変数から取るようにしておくと柔軟です（なければ "rss-reports"）
const BUCKET = process.env.R2_BUCKET_NAME || "rss-reports";

module.exports = {
  async upload(key, body, contentType) {
    try {
      return await retry(() => s3.send(new PutObjectCommand({
        Bucket: BUCKET, 
        Key: key, 
        Body: body, 
        ContentType: contentType
      })));
    } catch (e) {
      console.error(`[R2 Upload Error] Key: ${key}`, e.name, e.message);
      throw e; // 書き込み失敗は致命的なのでスローする
    }
  },

  async download(key) {
    try {
      const res = await retry(() => s3.send(new GetObjectCommand({ 
        Bucket: BUCKET, 
        Key: key 
      })));
      return await res.Body.transformToString();
    } catch (e) {
      // 404 (NoSuchKey) 以外のエラー（認証エラーなど）をログに出す
      if (e.name !== 'NoSuchKey') {
        console.error(`[R2 Download Error] Key: ${key}`);
        console.error(`Status: ${e.$metadata?.httpStatusCode}`);
        console.error(`Error Name: ${e.name}`);
        console.error(`Message: ${e.message}`);
      } else {
        console.warn(`[R2 Download] File not found: ${key}`);
      }
      return null;
    }
  }
};
