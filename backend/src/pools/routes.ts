import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { rankPredictions } from "../leaderboard/algorithm.js";
import { submitPrediction } from "../predictions/service.js";
import { getReceipt } from "../receipts/service.js";
import { startReplay } from "../replay/service.js";
import { txlineClient, TxlineUnavailableError } from "../txline/client.js";
import { getFixtureByTxlineId, upsertFixture } from "../txline/repository.js";
import { upsertDemoUser } from "../telegram/auth.js";
import { requireAdmin, requireDemoMode } from "../utils/admin.js";
import { requireUser, userId } from "../utils/http.js";
import { issuePoolInvite, requirePoolInvite } from "../utils/invite.js";
import { rateLimit } from "../utils/rateLimit.js";
import {
  createPool,
  getPool,
  insertLeaderboardSnapshot,
  insertScoreEvent,
  latestScoreEvent,
  listPredictions
} from "./repository.js";

const createPoolSchema = z.object({
  telegramChatId: z.string().min(1),
  txlineFixtureId: z.string().min(1),
  mode: z.enum(["live", "replay"]).default("replay"),
  createdByUserId: z.string().uuid().optional()
});

const predictionSchema = z.object({
  predictedHomeGoals: z.number().int().min(0).max(9),
  predictedAwayGoals: z.number().int().min(0).max(9)
});

function poolIdParam(c: Context) {
  const poolId = c.req.param("poolId");
  if (!poolId) throw new Error("Missing poolId route parameter");
  return poolId;
}

export function createPoolRoutes() {
  const app = new Hono();

  app.post("/", requireAdmin, async (c) => {
    const body = createPoolSchema.parse(await c.req.json());
    let fixture = getFixtureByTxlineId(body.txlineFixtureId);
    if (!fixture) {
      try {
        const fixtures = await txlineClient.fixtures(body.mode === "replay" ? "replayable" : "upcoming");
        fixture = fixtures.map(upsertFixture).find((item) => item.txlineFixtureId === body.txlineFixtureId) ?? null;
      } catch (error) {
        if (error instanceof TxlineUnavailableError) return c.json({ error: error.message }, 502);
        throw error;
      }
    }
    if (!fixture) return c.json({ error: "Fixture not found" }, 404);
    const pool = createPool({
      telegramChatId: body.telegramChatId,
      txlineFixtureDbId: fixture.id,
      createdByUserId: body.createdByUserId ?? null,
      mode: body.mode,
      lockAt: fixture.kickoffAt
    });
    const inviteToken = issuePoolInvite(pool.id);
    return c.json({
      poolId: pool.id,
      inviteToken,
      miniAppUrl: `${config.PUBLIC_MINI_APP_URL}/pool/${pool.id}?invite=${encodeURIComponent(inviteToken)}`
    });
  });

  app.get("/:poolId", rateLimit("pool:read", 120, 60_000), requireUser, requirePoolInvite, (c) => {
    const pool = getPool(poolIdParam(c));
    if (!pool) return c.json({ error: "Pool not found" }, 404);
    const predictions = listPredictions(pool.id);
    return c.json({
      pool,
      participantCount: predictions.length,
      score: latestScoreEvent(pool.id)
    });
  });

  app.post("/:poolId/predictions", rateLimit("pool:predict", 30, 60_000), requireUser, requirePoolInvite, async (c) => {
    const body = predictionSchema.parse(await c.req.json());
    try {
      const prediction = submitPrediction({
        poolId: poolIdParam(c),
        userId: userId(c),
        predictedHomeGoals: body.predictedHomeGoals,
        predictedAwayGoals: body.predictedAwayGoals
      });
      return c.json({ prediction });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Prediction failed" }, 400);
    }
  });

  app.post("/:poolId/demo-predictions", requireDemoMode, requireAdmin, async (c) => {
    const poolId = poolIdParam(c);
    const demoUsers = [
      { name: "Raghav", home: 3, away: 3 },
      { name: "Priya", home: 1, away: 0 },
      { name: "Aman", home: 2, away: 1 }
    ];
    const predictions = [];
    const errors = [];
    for (const demo of demoUsers) {
      const user = upsertDemoUser(demo.name);
      try {
        predictions.push(
          submitPrediction({
            poolId,
            userId: user.id,
            predictedHomeGoals: demo.home,
            predictedAwayGoals: demo.away
          })
        );
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Demo prediction failed");
      }
    }
    if (predictions.length === 0 && errors.length > 0) return c.json({ error: errors[0] }, 400);
    return c.json({ predictions });
  });

  app.get("/:poolId/leaderboard", rateLimit("pool:read", 120, 60_000), requireUser, requirePoolInvite, (c) => {
    const pool = getPool(poolIdParam(c));
    if (!pool) return c.json({ error: "Pool not found" }, 404);
    const predictions = listPredictions(pool.id);
    if (pool.status === "open") {
      return c.json({ hidden: true, participantCount: predictions.length, leaderboard: [] });
    }
    const score = latestScoreEvent(pool.id);
    const homeGoals = score?.homeGoals ?? pool.finalHomeGoals ?? 0;
    const awayGoals = score?.awayGoals ?? pool.finalAwayGoals ?? 0;
    return c.json({
      hidden: false,
      score: { homeGoals, awayGoals, matchStatus: score?.matchStatus, matchClock: score?.matchClock },
      leaderboard: rankPredictions(predictions, homeGoals, awayGoals)
    });
  });

  app.get("/:poolId/snapshot", rateLimit("pool:read", 120, 60_000), requireUser, requirePoolInvite, (c) => {
    const pool = getPool(poolIdParam(c));
    if (!pool) return c.json({ error: "Pool not found" }, 404);
    const score = latestScoreEvent(pool.id);
    const homeGoals = score?.homeGoals ?? pool.finalHomeGoals ?? 0;
    const awayGoals = score?.awayGoals ?? pool.finalAwayGoals ?? 0;
    const leaderboard = pool.status === "open" ? [] : rankPredictions(listPredictions(pool.id), homeGoals, awayGoals);
    return c.json({ score, leaderboard });
  });

  app.post("/:poolId/snapshot", rateLimit("pool:admin:snapshot", 20, 60_000), requireAdmin, async (c) => {
    const pool = getPool(poolIdParam(c));
    if (!pool) return c.json({ error: "Pool not found" }, 404);
    let snapshot;
    try {
      snapshot = await txlineClient.snapshot(pool.fixture.txlineFixtureId);
    } catch (error) {
      if (error instanceof TxlineUnavailableError) return c.json({ error: error.message }, 502);
      throw error;
    }
    const scoreEventId = insertScoreEvent(pool, snapshot);
    const leaderboard = rankPredictions(listPredictions(pool.id), snapshot.homeGoals, snapshot.awayGoals);
    insertLeaderboardSnapshot({
      poolId: pool.id,
      scoreEventId,
      homeGoals: snapshot.homeGoals,
      awayGoals: snapshot.awayGoals,
      snapshot: leaderboard
    });
    return c.json({ score: snapshot, leaderboard });
  });

  app.get("/:poolId/events", rateLimit("pool:events", 60, 60_000), requireUser, requirePoolInvite, async (c) => {
    const pool = getPool(poolIdParam(c));
    if (!pool) return c.json({ error: "Pool not found" }, 404);
    const latest = latestScoreEvent(pool.id);
    return c.newResponse(
      `event: snapshot\ndata: ${JSON.stringify({ poolId: pool.id, score: latest })}\n\n`,
      200,
      { "content-type": "text/event-stream", "cache-control": "no-cache" }
    );
  });

  app.post("/:poolId/replay/start", rateLimit("pool:admin:replay", 10, 60_000), requireAdmin, async (c) => {
    try {
      const result = await startReplay(poolIdParam(c));
      return c.json(result);
    } catch (error) {
      if (error instanceof TxlineUnavailableError) {
        return c.json({ error: error.message }, 502);
      }
      return c.json({ error: error instanceof Error ? error.message : "Replay failed" }, 400);
    }
  });

  app.get("/:poolId/result", rateLimit("pool:read", 120, 60_000), requireUser, requirePoolInvite, (c) => {
    const pool = getPool(poolIdParam(c));
    if (!pool) return c.json({ error: "Pool not found" }, 404);
    const predictions = listPredictions(pool.id);
    if (pool.status !== "resolved" || pool.finalHomeGoals === null || pool.finalAwayGoals === null) {
      return c.json({ error: "Pool is not resolved yet" }, 409);
    }
    const leaderboard = rankPredictions(predictions, pool.finalHomeGoals, pool.finalAwayGoals);
    const winningDistance = leaderboard[0]?.distance ?? null;
    return c.json({
      finalScore: { homeGoals: pool.finalHomeGoals, awayGoals: pool.finalAwayGoals },
      winners: leaderboard.filter((entry) => entry.distance === winningDistance),
      leaderboard
    });
  });

  app.get("/:poolId/receipt", rateLimit("pool:read", 120, 60_000), requireUser, requirePoolInvite, (c) => {
    const receipt = getReceipt(poolIdParam(c));
    if (!receipt) return c.json({ error: "Receipt not found" }, 404);
    return c.json({ receipt });
  });

  return app;
}
