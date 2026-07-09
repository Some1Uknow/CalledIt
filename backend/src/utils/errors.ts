import type { Context } from "hono";
import { ZodError } from "zod";

export function handleError(error: unknown, c: Context) {
  if (error instanceof ZodError) {
    return c.json({ error: "Invalid request", issues: error.issues.map((issue) => issue.path.join(".")).filter(Boolean) }, 400);
  }

  if (error instanceof SyntaxError) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
}
