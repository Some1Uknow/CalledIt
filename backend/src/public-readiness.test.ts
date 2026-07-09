import { Hono } from "hono";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { handleError } from "./utils/errors.js";
import { issuePoolInvite, verifyPoolInvite } from "./utils/invite.js";

describe("public readiness safeguards", () => {
  it("returns 400 for malformed Zod-validated requests", async () => {
    const app = new Hono();
    const schema = z.object({ initData: z.string().min(1) });
    app.onError(handleError);
    app.post("/auth", async (c) => c.json(schema.parse(await c.req.json())));

    const response = await app.request("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(400);
  });

  it("binds signed pool invites to one pool id", () => {
    const validInvite = issuePoolInvite("pool-id");
    expect(verifyPoolInvite("pool-id", validInvite)).toBe(true);
    expect(verifyPoolInvite("other-pool-id", validInvite)).toBe(false);
    expect(verifyPoolInvite("pool-id", null)).toBe(false);
  });
});
