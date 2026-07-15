import { createDecipheriv } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const sourcePath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const destination = path.resolve(process.env.DATABASE_PATH ?? "./calledit-restored.db");
if (!sourcePath) throw new Error("Usage: npm run restore -- <encrypted-backup>");

try {
  await stat(destination);
  throw new Error(`Refusing to overwrite existing database: ${destination}`);
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    // Expected: restore only to a new path.
  } else {
    throw error;
  }
}

const encrypted = await readFile(sourcePath);
if (encrypted.subarray(0, 5).toString() !== "CLDB1" || encrypted.length < 34) {
  throw new Error("Invalid CalledIt encrypted backup");
}

const key = encryptionKey();
const iv = encrypted.subarray(5, 17);
const tag = encrypted.subarray(17, 33);
const decipher = createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(tag);
const plaintext = Buffer.concat([decipher.update(encrypted.subarray(33)), decipher.final()]);
const pending = `${destination}.${process.pid}.restore`;

await mkdir(path.dirname(destination), { recursive: true });
try {
  await writeFile(pending, plaintext, { flag: "wx", mode: 0o600 });
  const restored = new DatabaseSync(pending, { readOnly: true });
  try {
    const result = restored.prepare("PRAGMA quick_check").get();
    if (!result || Object.values(result)[0] !== "ok") throw new Error("Restored database failed PRAGMA quick_check");
  } finally {
    restored.close();
  }
  await rename(pending, destination);
} finally {
  await rm(pending, { force: true });
}

console.log(destination);

function encryptionKey() {
  const encoded = process.env.BACKUP_ENCRYPTION_KEY;
  if (!encoded) throw new Error("BACKUP_ENCRYPTION_KEY is required (base64-encoded 32-byte key)");
  const value = Buffer.from(encoded, "base64");
  if (value.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return value;
}
