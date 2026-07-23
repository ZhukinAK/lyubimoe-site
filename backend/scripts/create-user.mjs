import crypto from "node:crypto";
import { hashPassword } from "../src/security.js";

function value(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);
  return process.argv[index + 1];
}
function quote(text) { return `'${String(text).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`; }

const username = value("username").trim().toLowerCase();
const displayName = value("display-name").trim();
const password = value("password");
const roomId = process.env.ROOM_ID || "22222222-2222-4222-8222-222222222222";
const roomSlug = process.env.ROOM_SLUG || "preview";
const userId = crypto.randomUUID();
const passwordHash = await hashPassword(password);

process.stdout.write(`-- Apply this generated YQL through the authenticated YDB console.\n`);
process.stdout.write(`UPSERT INTO rooms (id, slug, name, created_at) VALUES (${quote(roomId)}, ${quote(roomSlug)}, 'Наша комната', CurrentUtcTimestamp());\n`);
process.stdout.write(`UPSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at) VALUES (${quote(userId)}, ${quote(username)}, ${quote(displayName)}, ${quote(passwordHash)}, 'active', CurrentUtcTimestamp(), CurrentUtcTimestamp());\n`);
process.stdout.write(`UPSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (${quote(roomId)}, ${quote(userId)}, 'member', CurrentUtcTimestamp());\n`);
