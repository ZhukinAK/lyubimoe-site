import { createApp } from "./app.js";
import { verifyPassword } from "./security.js";
import { createStorage } from "./storage.js";
import { createYdbRepository } from "./ydb-repository.js";

let appPromise;

function env(name, fallback) {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function initialize() {
  const repo = await createYdbRepository({ endpoint: env("YDB_ENDPOINT"), database: env("YDB_DATABASE") });
  const storage = createStorage({
    bucket: env("S3_BUCKET"),
    accessKeyId: env("S3_ACCESS_KEY_ID"),
    secretAccessKey: env("S3_SECRET_ACCESS_KEY")
  });
  const app = createApp({
    repo,
    storage,
    passwordVerifier: verifyPassword,
    config: {
      allowedOrigins: env("ALLOWED_ORIGINS").split(",").map((value) => value.trim()),
      cookieDomain: env("COOKIE_DOMAIN", ".bibizana-chi.ru"),
      roomSlug: env("ROOM_SLUG", "preview")
    }
  });
  return { app, repo, storage };
}

export async function handler(event) {
  appPromise ||= initialize();
  const { app, repo, storage } = await appPromise;
  if (!event?.httpMethod && (event?.messages || event?.action === "cleanup-pending")) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const stale = await repo.listStaleGallery(cutoff);
    let removed = 0;
    for (const item of stale) {
      try { await storage.remove(item.objectKey); } catch (error) { console.error("pending_object_delete_failed", { key: item.objectKey, message: error.message }); }
      await repo.expireGallery({ id: item.id, roomId: item.roomId, version: item.version, now });
      removed += 1;
    }
    return { statusCode: 200, body: JSON.stringify({ removed }) };
  }
  return app(event);
}
