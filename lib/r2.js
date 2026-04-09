const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { retry } = require("./utils");

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = "rss-reports"; // ← ここが実際のバケット名と一致しているか確認！

module.exports = {
  async upload(key, body, contentType) {
    try {
      console.log(`[R2 Upload Attempt] Target: ${key} in ${BUCKET}`);
      const res = await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key: key, Body: body, ContentType: contentType
      }));
      console.log(`[R2 Upload Success] ${key}`);
      return res;
    } catch (e) {
      // エラーの詳細を表示させる
      console.error(`[R2 Upload ERROR] Key: ${key}, Error: ${e.message}`);
      console.error(`[Debug Info] Bucket: ${BUCKET}, AccountID: ${process.env.R2_ACCOUNT_ID ? 'Set' : 'Missing'}`);
      throw e;
    }
  },
  async download(key) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      return await res.Body.transformToString();
    } catch (e) {
      console.warn(`[R2 Download Warning] ${key} not found: ${e.message}`);
      return null;
    }
  }
};
