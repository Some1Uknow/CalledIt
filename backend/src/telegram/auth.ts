import { randomUUID } from "node:crypto";
import { db, nowIso } from "../db/client.js";

export type TelegramUserInput = {
  telegramUserId: string;
  telegramUsername?: string | null;
  displayName: string;
  photoUrl?: string | null;
};

export function upsertUser(input: TelegramUserInput) {
  const existing = db.prepare("SELECT id FROM users WHERE telegram_user_id = ?").get(input.telegramUserId) as
    | { id: string }
    | undefined;
  const id = existing?.id ?? randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, telegram_user_id, telegram_username, display_name, photo_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      telegram_username = excluded.telegram_username,
      display_name = excluded.display_name,
      photo_url = excluded.photo_url,
      updated_at = excluded.updated_at`
  ).run(id, input.telegramUserId, input.telegramUsername ?? null, input.displayName, input.photoUrl ?? null, now, now);
  return {
    id,
    telegramUserId: input.telegramUserId,
    telegramUsername: input.telegramUsername,
    displayName: input.displayName,
    photoUrl: input.photoUrl
  };
}
