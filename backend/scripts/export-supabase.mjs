import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const required = (name) => {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
  return process.env[name];
};
const output = path.resolve(process.env.EXPORT_DIR || "../migration/export");
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const client = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), accessToken ? {
  global: { headers: { Authorization: `Bearer ${accessToken}` } },
  auth: { persistSession: false, autoRefreshToken: false }
} : undefined);
if (!accessToken) {
  const { error: signInError } = await client.auth.signInAnonymously();
  if (signInError) throw signInError;
}
const { data: roomId, error: joinError } = await client.rpc("join_room", {
  p_slug: process.env.ROOM_SLUG || "preview",
  p_passphrase: required("ROOM_PASSPHRASE")
});
if (joinError) throw joinError;

await fs.mkdir(path.join(output, "gallery"), { recursive: true });
const readTable = async (table) => {
  const { data, error } = await client.from(table).select("*").eq("room_id", roomId);
  if (error) throw error;
  return data;
};
const memories = await readTable("memories");
const galleryItems = await readTable("gallery_items");
const files = [];
for (const item of galleryItems.filter((value) => !value.deleted_at)) {
  const { data, error } = await client.storage.from("gallery").download(item.storage_path);
  if (error) throw error;
  const bytes = Buffer.from(await data.arrayBuffer());
  const name = `${item.id}${path.extname(item.storage_path) || ".jpg"}`;
  await fs.writeFile(path.join(output, "gallery", name), bytes);
  files.push({ id: item.id, storagePath: item.storage_path, file: name, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
}
const manifest = { exportedAt: new Date().toISOString(), roomId, counts: { memories: memories.length, galleryItems: galleryItems.length, files: files.length }, memories, galleryItems, files };
await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
process.stdout.write(`Exported ${memories.length} memories and ${files.length} files to ${output}\n`);
