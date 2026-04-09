const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { retry } = require("./utils");

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucketName = process.env.R2_BUCKET_NAME || "rss-reports";

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: accessKeyId,
    secretAccessKey: secretAccessKey,
  },
  // Cloudflare R2 を AWS SDK で操作するための必須設定
  forcePathStyle: true, 
});

module.exports = {
  async upload(key, body, contentType) {
    try {
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
      });
      return await retry(() => s3.send(command));
    } catch (e) {
      console.error(`[R2 Upload Error] ${key}:`, e.message);
      throw e;
    }
  },

  async download(key) {
    try {
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      });
      const res = await retry(() => s3.send(command));
      return await res.Body.transformToString();
    } catch (e) {
      if (e.name !== "NoSuchKey" && e.name !== "NotFound") {
        console.error(`[R2 Download Error] ${key}:`, e.name, e.message);
        throw e; 
      }
      return null;
    }
  }
};
