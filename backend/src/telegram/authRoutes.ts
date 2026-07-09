import { Hono } from "hono";
import { z } from "zod";
import { rateLimit } from "../utils/rateLimit.js";
import { issueSession, upsertUser, verifyTelegramInitData } from "./auth.js";

const authSchema = z.object({ initData: z.string().min(1) });

export function createAuthRoutes() {
  const app = new Hono();

  app.post("/telegram", rateLimit("auth:telegram", 30, 60_000), async (c) => {
    const body = authSchema.parse(await c.req.json());
    const telegramUser = verifyTelegramInitData(body.initData);
    if (!telegramUser) return c.json({ error: "Invalid Telegram init data" }, 401);
    const user = upsertUser(telegramUser);
    const sessionToken = await issueSession(user.id);
    return c.json({ user: { id: user.id, displayName: user.displayName }, sessionToken });
  });

  return app;
}
