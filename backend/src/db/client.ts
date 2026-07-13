import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { config } from "../config.js";

export const db = new DatabaseSync(config.DATABASE_PATH);
if (config.DATABASE_PATH !== ":memory:") chmodSync(config.DATABASE_PATH, 0o600);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA busy_timeout = 5000");

export function assertDatabaseReady() {
  const result = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  if (!result || Object.values(result)[0] !== "ok") throw new Error("SQLite quick check failed");
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
}

export function nowIso() {
  return new Date().toISOString();
}

export function json<T>(value: T): string {
  return JSON.stringify(value);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
}
