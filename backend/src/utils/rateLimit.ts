import type { Context, Next } from "hono";

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

function clientKey(c: Context) {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "local"
  );
}

export function rateLimit(name: string, limit: number, windowMs: number) {
  return async (c: Context, next: Next) => {
    const now = Date.now();
    const key = `${name}:${clientKey(c)}`;
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }

    if (current.count >= limit) {
      c.header("retry-after", String(Math.ceil((current.resetAt - now) / 1000)));
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    current.count += 1;
    await next();
  };
}
