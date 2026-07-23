import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { sha256 } from "../src/security.js";

const origin = "https://www.bibizana-chi.ru";
const now = new Date("2026-07-22T12:00:00.000Z");

function request(method, path, body, cookie, extraHeaders = {}) {
  return {
    httpMethod: method,
    path: `/v1${path}`,
    headers: { origin, ...(cookie ? { cookie } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

function fixture() {
  const user = { id: "11111111-1111-4111-8111-111111111111", username: "alex", displayName: "Александр", passwordHash: "hash", active: true };
  const room = { userId: user.id, roomId: "22222222-2222-4222-8222-222222222222", roomSlug: "preview", roomName: "Наша комната", role: "member", user };
  const sessions = new Map([[sha256("valid-token"), { tokenHash: sha256("valid-token"), userId: user.id, expiresAt: new Date("2026-08-01T00:00:00Z") }]]);
  const memories = [];
  const gallery = [];
  const repo = {
    getUserByUsername: async (name) => name === user.username ? user : null,
    getPublicUser: async () => user,
    getMembership: async (userId, slug) => userId === user.id && slug === "preview" ? room : null,
    allowLoginAttempt: async () => true,
    recordLoginFailure: async () => {},
    createSession: async (session) => sessions.set(session.tokenHash, session),
    getSession: async (hash, at) => {
      const session = sessions.get(hash);
      return session && session.expiresAt > at ? session : null;
    },
    revokeSession: async (hash) => sessions.delete(hash),
    listMemories: async () => memories.filter((item) => !item.deletedAt).map((item) => ({
      ...item,
      authorDisplayName: user.displayName,
      author_display_name: user.displayName
    })),
    createMemory: async (input) => {
      const item = { ...input, memory_date: input.memoryDate, created_at: input.now.toISOString(), version: 1 };
      memories.push(item);
      return item;
    },
    deleteMemory: async ({ id, version, now: at }) => {
      const item = memories.find((value) => value.id === id);
      if (!item || item.version !== version) throw Object.assign(new Error("conflict"), { status: 409 });
      item.deletedAt = at;
    },
    listGallery: async () => gallery.filter((item) => item.status === "ready" && !item.deletedAt).map((item) => ({
      ...item,
      authorDisplayName: user.displayName,
      author_display_name: user.displayName
    })),
    createGalleryIntent: async (input) => {
      const item = { ...input, storage_path: input.objectKey, created_at: input.now.toISOString(), status: "pending", version: 1 };
      gallery.push(item);
      return item;
    },
    getGalleryItem: async (id) => gallery.find((item) => item.id === id && !item.deletedAt),
    completeGallery: async ({ id }) => {
      const item = gallery.find((value) => value.id === id);
      item.status = "ready";
      item.version += 1;
      return item;
    },
    deleteGallery: async ({ id, version, now: at }) => {
      const item = gallery.find((value) => value.id === id);
      if (!item || item.version !== version) throw new Error("conflict");
      item.deletedAt = at;
      return item;
    }
  };
  const storage = {
    uploadUrl: async (key) => `https://storage.test/${key}?upload`,
    readUrl: async (key) => `https://storage.test/${key}?read`,
    head: async () => ({ size: 1234, contentType: "image/jpeg" }),
    remove: async () => {}
  };
  const app = createApp({
    repo,
    storage,
    passwordVerifier: async (_hash, password) => password === "correct-password",
    config: { allowedOrigins: [origin], cookieDomain: ".bibizana-chi.ru", roomSlug: "preview" },
    now: () => new Date(now)
  });
  return { app, memories, gallery };
}

function body(result) { return result.body ? JSON.parse(result.body) : {}; }

test("health is public and private endpoints require a session", async () => {
  const { app } = fixture();
  assert.equal((await app(request("GET", "/health"))).statusCode, 200);
  assert.equal((await app({
    ...request("GET", "/ignored"),
    path: "/{proxy+}",
    url: "/v1/health"
  })).statusCode, 200);
  assert.equal((await app({
    ...request("GET", "/ignored"),
    path: "/{proxy+}",
    url: "https://example.apigw.yandexcloud.net/v1/health"
  })).statusCode, 200);
  const result = await app(request("GET", "/memories"));
  assert.equal(result.statusCode, 401);
  assert.equal(body(result).error.code, "authentication_required");
});

test("login validates credentials and sets an HttpOnly cookie", async () => {
  const { app } = fixture();
  const bad = await app(request("POST", "/auth/login", { username: "alex", password: "wrong-password" }));
  assert.equal(bad.statusCode, 401);
  const good = await app(request("POST", "/auth/login", { username: "alex", password: "correct-password" }));
  assert.equal(good.statusCode, 200);
  assert.match(good.headers["set-cookie"], /HttpOnly/);
  assert.match(good.headers["set-cookie"], /Secure/);
  assert.deepEqual(body(good).room, {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "preview",
    name: "Наша комната"
  });
  assert.equal(body(good).user.displayName, "Александр");
});

test("unknown origins cannot mutate data", async () => {
  const { app } = fixture();
  const event = request("POST", "/memories", { text: "Тест", memoryDate: "2026-07-22", label: "момент" }, "lyubimoe_session=valid-token");
  event.headers.origin = "https://evil.example";
  const result = await app(event);
  assert.equal(result.statusCode, 403);
  assert.equal(body(result).error.code, "origin_forbidden");
});

test("memory lifecycle preserves calendar date and version", async () => {
  const { app, memories } = fixture();
  const created = await app(request("POST", "/memories", { text: "Наш день", memoryDate: "2026-07-20", label: "важное" }, "lyubimoe_session=valid-token"));
  assert.equal(created.statusCode, 201);
  assert.equal(body(created).item.memory_date, "2026-07-20");
  assert.equal(body(created).item.authorDisplayName, "Александр");
  assert.equal(body(created).item.author_display_name, "Александр");
  const id = body(created).item.id;
  const listed = await app(request("GET", "/memories", undefined, "lyubimoe_session=valid-token"));
  assert.equal(body(listed).items.length, 1);
  assert.equal(body(listed).items[0].authorDisplayName, "Александр");
  const deleted = await app(request("DELETE", `/memories/${id}`, undefined, "lyubimoe_session=valid-token", { "if-match": "1" }));
  assert.equal(deleted.statusCode, 200);
  assert.ok(memories[0].deletedAt);
});

test("deletion requires optimistic-concurrency version", async () => {
  const { app } = fixture();
  const result = await app(request("DELETE", "/memories/33333333-3333-4333-8333-333333333333", undefined, "lyubimoe_session=valid-token"));
  assert.equal(result.statusCode, 428);
  assert.equal(body(result).error.code, "version_required");
});

test("gallery uses a pending intent before exposing the item", async () => {
  const { app, gallery } = fixture();
  const intent = await app(request("POST", "/gallery/upload-intent", { caption: "Фото", contentType: "image/jpeg", size: 1234 }, "lyubimoe_session=valid-token"));
  assert.equal(intent.statusCode, 201);
  assert.match(body(intent).uploadUrl, /upload/);
  let listed = await app(request("GET", "/gallery", undefined, "lyubimoe_session=valid-token"));
  assert.equal(body(listed).items.length, 0);
  const complete = await app(request("POST", "/gallery/complete", { id: gallery[0].id }, "lyubimoe_session=valid-token"));
  assert.equal(complete.statusCode, 200);
  assert.equal(body(complete).item.authorDisplayName, "Александр");
  listed = await app(request("GET", "/gallery", undefined, "lyubimoe_session=valid-token"));
  assert.equal(body(listed).items.length, 1);
  assert.match(body(listed).items[0].imageUrl, /read/);
  assert.equal(body(listed).items[0].author_display_name, "Александр");
});
