import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.env.EXPORT_DIR || "../migration/export");
const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
const problems = [];
for (const file of manifest.files) {
  const bytes = await fs.readFile(path.join(root, "gallery", file.file));
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (hash !== file.sha256 || bytes.length !== file.size) problems.push(file.file);
}
if (manifest.counts.memories !== manifest.memories.length) problems.push("memory count");
if (manifest.counts.galleryItems !== manifest.galleryItems.length) problems.push("gallery item count");
if (problems.length) throw new Error(`Export verification failed: ${problems.join(", ")}`);
process.stdout.write(`Verified ${manifest.memories.length} memories and ${manifest.files.length} files.\n`);
