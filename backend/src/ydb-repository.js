import crypto from "node:crypto";
import ydbSdk from "ydb-sdk";
import { ApiError } from "./errors.js";

const { Driver, MetadataAuthService, TypedData } = ydbSdk;
const UNKNOWN_AUTHOR = "Неизвестный бибизян";

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function rows(result) {
  const set = result?.resultSets?.[0];
  return set ? TypedData.createNativeObjects(set) : [];
}

function calendarDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function mapMemory(row) {
  const authorDisplayName = row.author_username === "legacy" ? UNKNOWN_AUTHOR : (row.author_display_name || UNKNOWN_AUTHOR);
  return {
    id: row.id,
    roomId: row.room_id,
    authorId: row.author_id,
    authorDisplayName,
    author_display_name: authorDisplayName,
    text: row.text,
    memoryDate: calendarDate(row.memory_date),
    memory_date: calendarDate(row.memory_date),
    label: row.label,
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version)
  };
}

function mapGallery(row) {
  const authorDisplayName = row.author_username === "legacy" ? UNKNOWN_AUTHOR : (row.author_display_name || UNKNOWN_AUTHOR);
  return {
    id: row.id,
    roomId: row.room_id,
    authorId: row.author_id,
    authorDisplayName,
    author_display_name: authorDisplayName,
    caption: row.caption,
    objectKey: row.object_key,
    storage_path: row.object_key,
    contentType: row.content_type,
    size: Number(row.size),
    status: row.status,
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version)
  };
}

export async function createYdbRepository(config) {
  const driver = new Driver({ endpoint: config.endpoint, database: config.database, authService: new MetadataAuthService() });
  if (!(await driver.ready(10000))) throw new Error("YDB driver did not become ready");

  async function run(query) {
    return driver.tableClient.withSessionRetry((session) => session.executeQuery(query));
  }
  async function select(query) { return rows(await run(query)); }

  return {
    close: () => driver.destroy(),
    async getUserByUsername(username) {
      const [row] = await select(`SELECT * FROM users WHERE username = ${quote(username)} LIMIT 1;`);
      return row && { id: row.id, username: row.username, displayName: row.display_name, passwordHash: row.password_hash, active: row.status === "active" };
    },
    async getMembership(userId, roomSlug) {
      const [row] = await select(`SELECT rm.user_id AS user_id, rm.room_id AS room_id, rm.role AS role, r.slug AS slug, r.name AS name FROM room_members AS rm INNER JOIN rooms AS r ON rm.room_id = r.id WHERE rm.user_id = ${quote(userId)} AND r.slug = ${quote(roomSlug)} LIMIT 1;`);
      return row && { userId: row.user_id, roomId: row.room_id, roomSlug: row.slug, roomName: row.name, role: row.role, user: await this.getPublicUser(userId) };
    },
    async getPublicUser(userId) {
      const [row] = await select(`SELECT id, username, display_name FROM users WHERE id = ${quote(userId)} LIMIT 1;`);
      return row && { id: row.id, username: row.username, displayName: row.display_name };
    },
    async allowLoginAttempt(username, ip, now) {
      const since = new Date(now.getTime() - 15 * 60 * 1000);
      const [row] = await select(`SELECT COUNT(*) AS count FROM login_attempts WHERE success = false AND attempted_at >= Timestamp(${quote(since)}) AND (username = ${quote(username)} OR ip = ${quote(ip)});`);
      return Number(row?.count || 0) < 8;
    },
    recordLoginFailure: (username, ip, now) => run(`UPSERT INTO login_attempts (bucket, id, username, ip, success, attempted_at) VALUES (${quote(now.toISOString().slice(0, 10))}, ${quote(crypto.randomUUID())}, ${quote(username)}, ${quote(ip)}, false, Timestamp(${quote(now)}));`),
    createSession: ({ tokenHash, userId, expiresAt, ip }) => run(`UPSERT INTO sessions (token_hash, user_id, expires_at, created_at, revoked_at, ip) VALUES (${quote(tokenHash)}, ${quote(userId)}, Timestamp(${quote(expiresAt)}), CurrentUtcTimestamp(), NULL, ${quote(ip)});`),
    async getSession(tokenHash, now) {
      const [row] = await select(`SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ${quote(tokenHash)} AND revoked_at IS NULL AND expires_at > Timestamp(${quote(now)}) LIMIT 1;`);
      return row && { tokenHash: row.token_hash, userId: row.user_id, expiresAt: row.expires_at };
    },
    revokeSession: (tokenHash, now) => run(`UPDATE sessions SET revoked_at = Timestamp(${quote(now)}) WHERE token_hash = ${quote(tokenHash)};`),
    async listMemories(roomId) {
      return (await select(`SELECT m.room_id AS room_id, m.id AS id, m.author_id AS author_id, m.text AS text, m.memory_date AS memory_date, m.label AS label, m.created_at AS created_at, m.updated_at AS updated_at, m.deleted_at AS deleted_at, m.version AS version, u.username AS author_username, u.display_name AS author_display_name FROM memories AS m LEFT JOIN users AS u ON m.author_id = u.id WHERE m.room_id = ${quote(roomId)} AND m.deleted_at IS NULL ORDER BY m.memory_date DESC, m.created_at DESC;`)).map(mapMemory);
    },
    async createMemory(input) {
      await run(`INSERT INTO memories (room_id, id, author_id, text, memory_date, label, created_at, updated_at, deleted_at, version) VALUES (${quote(input.roomId)}, ${quote(input.id)}, ${quote(input.authorId)}, ${quote(input.text)}, Date(${quote(input.memoryDate)}), ${quote(input.label)}, Timestamp(${quote(input.now)}), Timestamp(${quote(input.now)}), NULL, 1);`);
      return mapMemory({ ...input, room_id: input.roomId, author_id: input.authorId, memory_date: input.memoryDate, created_at: input.now.toISOString(), updated_at: input.now.toISOString(), version: 1 });
    },
    async deleteMemory({ id, roomId, version, now }) {
      const [row] = await select(`SELECT version FROM memories WHERE room_id = ${quote(roomId)} AND id = ${quote(id)} AND deleted_at IS NULL LIMIT 1;`);
      if (!row || Number(row.version) !== version) throw new ApiError(409, "version_conflict", "Запись уже изменилась.");
      await run(`UPDATE memories SET deleted_at = Timestamp(${quote(now)}), updated_at = Timestamp(${quote(now)}), version = version + 1 WHERE room_id = ${quote(roomId)} AND id = ${quote(id)} AND version = ${version};`);
    },
    async listGallery(roomId) {
      return (await select(`SELECT g.room_id AS room_id, g.id AS id, g.author_id AS author_id, g.caption AS caption, g.object_key AS object_key, g.content_type AS content_type, g.size AS size, g.status AS status, g.created_at AS created_at, g.updated_at AS updated_at, g.deleted_at AS deleted_at, g.version AS version, u.username AS author_username, u.display_name AS author_display_name FROM gallery_items AS g LEFT JOIN users AS u ON g.author_id = u.id WHERE g.room_id = ${quote(roomId)} AND g.status = 'ready' AND g.deleted_at IS NULL ORDER BY g.created_at DESC;`)).map(mapGallery);
    },
    async createGalleryIntent(input) {
      await run(`INSERT INTO gallery_items (room_id, id, author_id, caption, object_key, content_type, size, status, created_at, updated_at, deleted_at, version) VALUES (${quote(input.roomId)}, ${quote(input.id)}, ${quote(input.authorId)}, ${quote(input.caption)}, ${quote(input.objectKey)}, ${quote(input.contentType)}, ${input.size}, 'pending', Timestamp(${quote(input.now)}), Timestamp(${quote(input.now)}), NULL, 1);`);
      return mapGallery({ ...input, room_id: input.roomId, author_id: input.authorId, object_key: input.objectKey, content_type: input.contentType, status: "pending", created_at: input.now.toISOString(), updated_at: input.now.toISOString(), version: 1 });
    },
    async getGalleryItem(id, roomId) {
      const [row] = await select(`SELECT * FROM gallery_items WHERE room_id = ${quote(roomId)} AND id = ${quote(id)} AND deleted_at IS NULL LIMIT 1;`);
      return row && mapGallery(row);
    },
    async listStaleGallery(cutoff) {
      return (await select(`SELECT * FROM gallery_items WHERE status = 'pending' AND deleted_at IS NULL AND created_at < Timestamp(${quote(cutoff)}) LIMIT 100;`)).map(mapGallery);
    },
    expireGallery: ({ id, roomId, version, now }) => run(`UPDATE gallery_items SET status = 'expired', deleted_at = Timestamp(${quote(now)}), updated_at = Timestamp(${quote(now)}), version = version + 1 WHERE room_id = ${quote(roomId)} AND id = ${quote(id)} AND version = ${version} AND status = 'pending';`),
    async completeGallery({ id, roomId, version, now }) {
      await run(`UPDATE gallery_items SET status = 'ready', updated_at = Timestamp(${quote(now)}), version = version + 1 WHERE room_id = ${quote(roomId)} AND id = ${quote(id)} AND version = ${version} AND status = 'pending';`);
      return this.getGalleryItem(id, roomId);
    },
    async deleteGallery({ id, roomId, version, now }) {
      const item = await this.getGalleryItem(id, roomId);
      if (!item || item.version !== version) throw new ApiError(409, "version_conflict", "Карточка уже изменилась.");
      await run(`UPDATE gallery_items SET deleted_at = Timestamp(${quote(now)}), updated_at = Timestamp(${quote(now)}), version = version + 1 WHERE room_id = ${quote(roomId)} AND id = ${quote(id)} AND version = ${version};`);
      return item;
    }
  };
}
