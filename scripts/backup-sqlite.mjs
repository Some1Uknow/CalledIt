import { createCipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const databasePath = path.resolve(process.env.DATABASE_PATH ?? "./calledit.db");
const backupDir = path.resolve(process.env.BACKUP_DIR ?? "./backups");
const retentionDays = Number.parseInt(process.env.BACKUP_RETENTION_DAYS ?? "7", 10);
const key = encryptionKey();

if (!Number.isInteger(retentionDays) || retentionDays < 1) {
  throw new Error("BACKUP_RETENTION_DAYS must be a positive integer");
}

await stat(databasePath);
await mkdir(backupDir, { recursive: true, mode: 0o700 });

const timestamp = new Date().toISOString().replaceAll(":", "-");
const snapshot = path.join(backupDir, `.calledit-${timestamp}-${process.pid}.db`);
const pending = path.join(backupDir, `.calledit-${timestamp}-${process.pid}.enc`);
const destination = path.join(backupDir, `calledit-${timestamp}.db.enc`);

try {
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }

  const plaintext = await readFile(snapshot);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  await writeFile(pending, Buffer.concat([Buffer.from("CLDB1"), iv, tag, ciphertext]), { mode: 0o600 });
  await rename(pending, destination);
} finally {
  await rm(snapshot, { force: true });
  await rm(pending, { force: true });
}

const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1_000;
for (const name of await readdir(backupDir)) {
  if (!/^calledit-.*\.db\.enc$/.test(name)) continue;
  const candidate = path.join(backupDir, name);
  if ((await stat(candidate)).mtimeMs < cutoff) await rm(candidate);
}

console.log(destination);

function encryptionKey() {
  const encoded = process.env.BACKUP_ENCRYPTION_KEY;
  if (!encoded) throw new Error("BACKUP_ENCRYPTION_KEY is required (base64-encoded 32-byte key)");
  const value = Buffer.from(encoded, "base64");
  if (value.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return value;
}
