import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { assertDatabaseReady } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { liveSupervisorStatus, startLiveSupervisor } from "./live/service.js";
import { addMarketRoutes } from "./market/routes.js";
import { createTelegramRoutes } from "./telegram/routes.js";
import { handleError } from "./utils/errors.js";

export function createApp() {
  const app = new Hono();

  app.onError(handleError);

  app.use("*", logger());

  app.get("/health", (c) => c.json({ ok: true, service: "calledit-backend" }));
  app.get("/ready", (c) => {
    try {
      assertDatabaseReady();
      const status = liveSupervisorStatus();
      const txline = {
        running: status.running,
        connected: status.connected,
        lastConnectedAt: status.lastConnectedAt,
        lastEventAt: status.lastEventAt
      };
      return c.json({ ok: true, degraded: !status.connected, database: "ready", txline });
    } catch {
      return c.json({ ok: false, database: "unavailable" }, 503);
    }
  });
  addMarketRoutes(app);
  app.route("/api/telegram", createTelegramRoutes());

  return app;
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  migrate();
  startLiveSupervisor();
  const app = createApp();
  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`CalledIt backend listening on http://localhost:${info.port}`);
  });
}

export default createApp();
