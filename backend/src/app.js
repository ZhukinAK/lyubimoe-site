import crypto from "node:crypto";
import { ApiError, assert } from "./errors.js";
import { SESSION_TTL_MS, newToken, parseCookies, sessionCookie, sha256 } from "./security.js";
import { entityId, loginInput, memoryInput, uploadInput } from "./validation.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function response(statusCode, body, headers = {}) {
  return { statusCode, headers: { ...JSON_HEADERS, ...headers }, body: body === undefined ? "" : JSON.stringify(body) };
}

function eventHeaders(event) {
  return Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
}

function requestPath(event) {
  // API Gateway request format 0.1 puts the matched OpenAPI template in
  // `path` and the actual requested URL in `url`.
  const value = event.url || event.path || event.requestContext?.http?.path || "/";
  try {
    return new URL(value, "https://api.invalid").pathname;
  } catch {
    return String(value).split("?")[0];
  }
}

function requestMethod(event) {
  return (event.httpMethod || event.requestContext?.http?.method || "GET").toUpperCase();
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try { return JSON.parse(raw); } catch { throw new ApiError(400, "invalid_json", "Некорректный JSON."); }
}

function routeMatch(path, template) {
  const names = [];
  const pattern = template.replace(/:[^/]+/g, (part) => { names.push(part.slice(1)); return "([^/]+)"; });
  const match = path.match(new RegExp(`^${pattern}$`));
  if (!match) return null;
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
}

export function createApp({ repo, storage, passwordVerifier, config, now = () => new Date() }) {
  const origins = new Set(config.allowedOrigins);

  async function authenticate(event) {
    const headers = eventHeaders(event);
    const token = parseCookies(headers.cookie).lyubimoe_session;
    assert(token, 401, "authentication_required", "Требуется вход.");
    const session = await repo.getSession(sha256(token), now());
    assert(session, 401, "session_expired", "Сессия истекла. Войдите снова.");
    const membership = await repo.getMembership(session.userId, config.roomSlug);
    assert(membership, 403, "room_forbidden", "Нет доступа к комнате.");
    return { ...session, ...membership };
  }

  return async function handler(event) {
    const headers = eventHeaders(event);
    const origin = headers.origin || "";
    const method = requestMethod(event);
    const path = requestPath(event).replace(/^\/v1(?=\/|$)/, "");
    const corsHeaders = origin && origins.has(origin) ? {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,if-match",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      vary: "Origin"
    } : {};

    try {
      if (method === "OPTIONS") {
        assert(origins.has(origin), 403, "origin_forbidden", "Источник запроса не разрешён.");
        return response(204, undefined, corsHeaders);
      }
      if (!["GET", "HEAD"].includes(method)) {
        assert(origins.has(origin), 403, "origin_forbidden", "Источник запроса не разрешён.");
      }
      if (method === "GET" && path === "/health") return response(200, { ok: true, time: now().toISOString() }, corsHeaders);

      if (method === "POST" && path === "/auth/login") {
        const { username, password } = loginInput(parseBody(event));
        const ip = headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
        assert(await repo.allowLoginAttempt(username, ip, now()), 429, "login_rate_limited", "Слишком много попыток. Попробуйте позже.");
        const user = await repo.getUserByUsername(username);
        const valid = user?.active && await passwordVerifier(user.passwordHash, password);
        if (!valid) {
          await repo.recordLoginFailure(username, ip, now());
          throw new ApiError(401, "invalid_credentials", "Неверное имя или пароль.");
        }
        const membership = await repo.getMembership(user.id, config.roomSlug);
        assert(membership, 403, "room_forbidden", "Нет доступа к комнате.");
        const token = newToken();
        await repo.createSession({ tokenHash: sha256(token), userId: user.id, expiresAt: new Date(now().getTime() + SESSION_TTL_MS), ip });
        return response(200, {
          user: { id: user.id, username: user.username, displayName: user.displayName },
          room: { id: membership.roomId, slug: membership.roomSlug, name: membership.roomName }
        }, {
          ...corsHeaders,
          "set-cookie": sessionCookie(token, config.cookieDomain)
        });
      }

      if (method === "POST" && path === "/auth/logout") {
        const token = parseCookies(headers.cookie).lyubimoe_session;
        if (token) await repo.revokeSession(sha256(token), now());
        return response(200, { ok: true }, { ...corsHeaders, "set-cookie": sessionCookie("", config.cookieDomain, 0) });
      }

      const auth = await authenticate(event);
      if (method === "GET" && path === "/auth/me") {
        return response(200, { user: auth.user, room: { id: auth.roomId, slug: auth.roomSlug, name: auth.roomName } }, corsHeaders);
      }
      if (method === "GET" && path === "/memories") return response(200, { items: await repo.listMemories(auth.roomId) }, corsHeaders);
      if (method === "POST" && path === "/memories") {
        const input = memoryInput(parseBody(event));
        const item = await repo.createMemory({ id: crypto.randomUUID(), roomId: auth.roomId, authorId: auth.userId, ...input, now: now() });
        return response(201, { item: { ...item, authorDisplayName: auth.user.displayName, author_display_name: auth.user.displayName } }, corsHeaders);
      }
      const memoryDelete = routeMatch(path, "/memories/:id");
      if (method === "DELETE" && memoryDelete) {
        const version = Number(headers["if-match"]);
        assert(Number.isInteger(version) && version > 0, 428, "version_required", "Передайте версию записи.");
        await repo.deleteMemory({ id: entityId(memoryDelete.id), roomId: auth.roomId, version, now: now() });
        return response(200, { ok: true }, corsHeaders);
      }
      if (method === "GET" && path === "/gallery") {
        const items = await repo.listGallery(auth.roomId);
        const withUrls = await Promise.all(items.map(async (item) => ({ ...item, imageUrl: await storage.readUrl(item.objectKey) })));
        return response(200, { items: withUrls }, corsHeaders);
      }
      if (method === "POST" && path === "/gallery/upload-intent") {
        const input = uploadInput(parseBody(event));
        const id = crypto.randomUUID();
        const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[input.contentType];
        const objectKey = `${auth.roomId}/${id}.${extension}`;
        const item = await repo.createGalleryIntent({ id, roomId: auth.roomId, authorId: auth.userId, objectKey, ...input, now: now() });
        return response(201, {
          item: { ...item, authorDisplayName: auth.user.displayName, author_display_name: auth.user.displayName },
          uploadUrl: await storage.uploadUrl(objectKey, input.contentType),
          expiresIn: 900
        }, corsHeaders);
      }
      if (method === "POST" && path === "/gallery/complete") {
        const body = parseBody(event);
        const id = entityId(body.id);
        const item = await repo.getGalleryItem(id, auth.roomId);
        assert(item?.status === "pending", 409, "upload_not_pending", "Загрузка уже завершена или отменена.");
        const metadata = await storage.head(item.objectKey);
        assert(metadata && metadata.size === item.size && metadata.contentType === item.contentType, 409, "upload_mismatch", "Параметры загруженного файла не совпадают.");
        const ready = await repo.completeGallery({ id, roomId: auth.roomId, version: item.version, now: now() });
        return response(200, {
          item: {
            ...ready,
            authorDisplayName: auth.user.displayName,
            author_display_name: auth.user.displayName,
            imageUrl: await storage.readUrl(ready.objectKey)
          }
        }, corsHeaders);
      }
      const galleryDelete = routeMatch(path, "/gallery/:id");
      if (method === "DELETE" && galleryDelete) {
        const version = Number(headers["if-match"]);
        assert(Number.isInteger(version) && version > 0, 428, "version_required", "Передайте версию карточки.");
        const item = await repo.deleteGallery({ id: entityId(galleryDelete.id), roomId: auth.roomId, version, now: now() });
        try { await storage.remove(item.objectKey); } catch (error) { console.error("object_delete_failed", { key: item.objectKey, message: error.message }); }
        return response(200, { ok: true }, corsHeaders);
      }
      throw new ApiError(404, "not_found", "Маршрут не найден.");
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, "internal_error", "Внутренняя ошибка.");
      if (apiError.status >= 500) console.error(error);
      return response(apiError.status, { error: { code: apiError.code, message: apiError.message, details: apiError.details } }, corsHeaders);
    }
  };
}
