import { Hono } from "hono";
import { requireAdmin } from "../utils/admin.js";
import { txlineClient, TxlineUnavailableError } from "./client.js";
import { upsertFixture } from "./repository.js";

export function createFixtureRoutes() {
  const app = new Hono();

  app.get("/upcoming", requireAdmin, async (c) => {
    try {
      const fixtures = await txlineClient.fixtures("upcoming");
      const saved = fixtures.map(upsertFixture);
      return c.json({ fixtures: saved });
    } catch (error) {
      if (error instanceof TxlineUnavailableError) return c.json({ error: error.message }, 502);
      throw error;
    }
  });

  app.get("/replayable", requireAdmin, async (c) => {
    try {
      const fixtures = await txlineClient.fixtures("replayable");
      const saved = fixtures.map(upsertFixture);
      return c.json({ fixtures: saved });
    } catch (error) {
      if (error instanceof TxlineUnavailableError) return c.json({ error: error.message }, 502);
      throw error;
    }
  });

  return app;
}
