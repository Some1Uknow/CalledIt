import type { Context, Next } from "hono";
import { verifySession } from "../telegram/auth.js";

export async function requireUser(c: Context, next: Next) {
  const authorization = c.req.header("authorization");
  const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return c.json({ error: "Missing bearer token" }, 401);
  try {
    const userId = await verifySession(token);
    c.set("userId", userId);
    await next();
  } catch {
    return c.json({ error: "Invalid session token" }, 401);
  }
}

export function userId(c: Context) {
  const id = c.get("userId");
  if (!id || typeof id !== "string") throw new Error("Missing authenticated user");
  return id;
}
