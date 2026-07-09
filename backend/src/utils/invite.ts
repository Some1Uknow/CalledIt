import { createHmac } from "node:crypto";
import type { Context, Next } from "hono";
import { config } from "../config.js";
import { secureCompare } from "./crypto.js";

type InvitePayload = {
  poolId: string;
  iat: number;
};

function b64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function sign(encodedPayload: string) {
  return createHmac("sha256", config.POOL_INVITE_SECRET).update(encodedPayload).digest("base64url");
}

export function issuePoolInvite(poolId: string) {
  const payload: InvitePayload = { poolId, iat: Math.floor(Date.now() / 1000) };
  const encodedPayload = b64url(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyPoolInvite(poolId: string, token: string | null | undefined) {
  if (!token) return false;
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return false;
  if (!secureCompare(signature, sign(encodedPayload))) return false;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as InvitePayload;
    return payload.poolId === poolId && Number.isInteger(payload.iat);
  } catch {
    return false;
  }
}

export async function requirePoolInvite(c: Context, next: Next) {
  const poolId = c.req.param("poolId");
  const invite = c.req.header("x-pool-invite") ?? c.req.query("invite");
  if (!poolId || !verifyPoolInvite(poolId, invite)) {
    return c.json({ error: "Valid pool invite required" }, 403);
  }
  await next();
}
