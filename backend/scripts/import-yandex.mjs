import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import ydbSdk from "ydb-sdk";

const { Driver, MetadataAuthService, TokenAuthService } = ydbSdk;

const required = (name) => {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
};
const quote = (value) => value == null
  ? "NULL"
  : `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
const timestamp = (value) => value ? `Timestamp(${quote(new Date(value).toISOString())})` : "NULL";
const mimeByExtension = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

const exportDir = path.resolve(process.env.EXPORT_DIR || "../migration/export");
const manifest = JSON.parse(await fs.readFile(path.join(exportDir, "manifest.json"), "utf8"));
const roomId = process.env.ROOM_ID || manifest.roomId;
const roomSlug = process.env.ROOM_SLUG || "preview";
const legacyUserId = process.env.LEGACY_USER_ID || "11111111-1111-4111-8111-111111111111";
const bucket = required("S3_BUCKET");
const authService = process.env.YDB_TOKEN
  ? new TokenAuthService(process.env.YDB_TOKEN)
  : new MetadataAuthService();
const driver = new Driver({ endpoint: required("YDB_ENDPOINT"), database: required("YDB_DATABASE"), authService });
if (!(await driver.ready(10000))) throw new Error("YDB driver did not become ready");
const s3 = new S3Client({
  endpoint: "https://storage.yandexcloud.net",
  region: "ru-central1",
  credentials: { accessKeyId: required("S3_ACCESS_KEY_ID"), secretAccessKey: required("S3_SECRET_ACCESS_KEY") }
});
const run = (query) => driver.tableClient.withSessionRetry((session) => session.executeQuery(query));

try {
  await run(`UPSERT INTO rooms (id, slug, name, created_at) VALUES (${quote(roomId)}, ${quote(roomSlug)}, 'Наша комната', CurrentUtcTimestamp());`);
  await run(`UPSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at) VALUES (${quote(legacyUserId)}, 'legacy', 'Архив', '!', 'system', CurrentUtcTimestamp(), CurrentUtcTimestamp());`);

  for (const item of manifest.memories) {
    await run(`UPSERT INTO memories (room_id, id, author_id, text, memory_date, label, created_at, updated_at, deleted_at, version) VALUES (${quote(roomId)}, ${quote(item.id)}, ${quote(legacyUserId)}, ${quote(item.text)}, Date(${quote(item.memory_date)}), ${quote(item.label || "момент")}, ${timestamp(item.created_at)}, ${timestamp(item.created_at)}, ${timestamp(item.deleted_at)}, 1);`);
  }

  const filesById = new Map(manifest.files.map((item) => [item.id, item]));
  for (const item of manifest.galleryItems) {
    const file = filesById.get(item.id);
    const extension = file ? path.extname(file.file).toLowerCase() : (path.extname(item.storage_path).toLowerCase() || ".jpg");
    const objectKey = `${roomId}/${item.id}${extension}`;
    let size = 0;
    let contentType = mimeByExtension[extension] || "image/jpeg";
    let status = "deleted";
    if (file) {
      const body = await fs.readFile(path.join(exportDir, "gallery", file.file));
      const checksum = crypto.createHash("sha256").update(body).digest("hex");
      if (checksum !== file.sha256 || body.length !== file.size) throw new Error(`Checksum mismatch: ${file.file}`);
      size = body.length;
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: body, ContentType: contentType }));
      status = "ready";
    }
    await run(`UPSERT INTO gallery_items (room_id, id, author_id, caption, object_key, content_type, size, status, created_at, updated_at, deleted_at, version) VALUES (${quote(roomId)}, ${quote(item.id)}, ${quote(legacyUserId)}, ${quote(item.caption || "")}, ${quote(objectKey)}, ${quote(contentType)}, ${size}, ${quote(status)}, ${timestamp(item.created_at)}, ${timestamp(item.created_at)}, ${timestamp(item.deleted_at)}, 1);`);
  }
  process.stdout.write(`Imported ${manifest.memories.length} memories and ${manifest.files.length} files.\n`);
} finally {
  await driver.destroy();
}
