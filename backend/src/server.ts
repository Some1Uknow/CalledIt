import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { pathToFileURL } from "node:url";
import { config, corsOrigins } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPoolRoutes } from "./pools/routes.js";
import { createFixtureRoutes } from "./txline/routes.js";
import { createTelegramRoutes } from "./telegram/routes.js";
import { createAuthRoutes } from "./telegram/authRoutes.js";
import { handleError } from "./utils/errors.js";

export function createApp() {
  const app = new Hono();

  app.onError(handleError);

  app.use("*", logger());
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return null;
        return corsOrigins.includes(origin) ? origin : null;
      }
    })
  );

  app.get("/health", (c) => c.json({ ok: true, service: "calledit-backend" }));
  app.route("/api/auth", createAuthRoutes());
  app.route("/api/fixtures", createFixtureRoutes());
  app.route("/api/pools", createPoolRoutes());
  app.route("/api/telegram", createTelegramRoutes());

  return app;
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  migrate();
  const app = createApp();
  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`CalledIt backend listening on http://localhost:${info.port}`);
  });
}

export default createApp();
