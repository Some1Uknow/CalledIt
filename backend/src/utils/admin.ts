import type { Context, Next } from "hono";
import { config } from "../config.js";
import { secureCompare } from "./crypto.js";

export async function requireAdmin(c: Context, next: Next) {
  if (!config.ADMIN_API_KEY) return c.json({ error: "Admin API is not configured" }, 403);

  const key = c.req.header("x-admin-api-key");
  if (!key || !secureCompare(key, config.ADMIN_API_KEY)) return c.json({ error: "Admin access required" }, 403);

  await next();
}

export async function requireDemoMode(c: Context, next: Next) {
  if (!config.DEMO_MODE) return c.json({ error: "Demo routes are disabled" }, 404);
  await next();
}
