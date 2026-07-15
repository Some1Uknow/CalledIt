import { db, nowIso } from "../db/client.js";

export function claimTelegramUpdate(updateId: string) {
  db.prepare("DELETE FROM telegram_updates WHERE processed_at IS NOT NULL AND created_at < ?").run(
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString()
  );
  const result = db
    .prepare("INSERT OR IGNORE INTO telegram_updates (update_id, created_at) VALUES (?, ?)")
    .run(updateId, nowIso());
  return result.changes === 1;
}

export function completeTelegramUpdate(updateId: string) {
  db.prepare("UPDATE telegram_updates SET processed_at = ? WHERE update_id = ?").run(nowIso(), updateId);
}

export function releaseTelegramUpdate(updateId: string) {
  db.prepare("DELETE FROM telegram_updates WHERE update_id = ? AND processed_at IS NULL").run(updateId);
}
