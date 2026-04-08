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

const BUCKET = "rss-reports";

module.exports = {
  async upload(key, body, contentType) {
    return retry(() => s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: body, ContentType: contentType
    })));
  },
  async download(key) {
    try {
      const res = await retry(() => s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })));
      return await res.Body.transformToString();
    } catch (e) { return null; }
  }
};
