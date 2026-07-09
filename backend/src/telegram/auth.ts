import { createHmac, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { config } from "../config.js";
import { db, nowIso } from "../db/client.js";
import { secureCompareHex } from "../utils/crypto.js";

const secret = new TextEncoder().encode(config.SESSION_SECRET);

export type TelegramUserInput = {
  telegramUserId: string;
  telegramUsername?: string | null;
  displayName: string;
  photoUrl?: string | null;
};

const telegramUserSchema = z.object({
  id: z.union([z.number(), z.string()]),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  photo_url: z.string().optional()
});

export async function issueSession(userId: string) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret);
}

export async function verifySession(token: string) {
  const result = await jwtVerify(token, secret);
  return String(result.payload.sub);
}

export function verifyTelegramInitData(initData: string) {
  if (!config.TELEGRAM_BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60) return null;
  if (now - authDate > config.TELEGRAM_INIT_MAX_AGE_SECONDS) return null;

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(config.TELEGRAM_BOT_TOKEN).digest();
  const computed = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!secureCompareHex(computed, hash)) return null;

  const rawUser = params.get("user");
  if (!rawUser) return null;
  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(rawUser);
  } catch {
    return null;
  }
  const parsed = telegramUserSchema.safeParse(rawParsed);
  if (!parsed.success) return null;
  const user = parsed.data;
  return {
    telegramUserId: String(user.id),
    telegramUsername: user.username ?? null,
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || `User ${user.id}`,
    photoUrl: user.photo_url ?? null
  };
}

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

export function upsertDemoUser(name = "Demo User") {
  return upsertUser({
    telegramUserId: `demo-${name.toLowerCase().replace(/\s+/g, "-")}`,
    displayName: name
  });
}
