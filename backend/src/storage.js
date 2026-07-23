import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function createStorage(config) {
  const client = new S3Client({
    endpoint: "https://storage.yandexcloud.net",
    region: "ru-central1",
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
  });
  return {
    uploadUrl: (key, contentType) => getSignedUrl(client, new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType }), { expiresIn: 900 }),
    readUrl: (key) => getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: 3600 }),
    async head(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return { size: Number(result.ContentLength), contentType: result.ContentType };
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    remove: (key) => client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
  };
}
