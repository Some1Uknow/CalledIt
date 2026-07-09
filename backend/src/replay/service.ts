import { rankPredictions } from "../leaderboard/algorithm.js";
import {
  getPool,
  insertLeaderboardSnapshot,
  insertScoreEvent,
  listPredictions,
  setPoolStatus
} from "../pools/repository.js";
import { resolvePool } from "../receipts/service.js";
import { txlineClient } from "../txline/client.js";

export async function startReplay(poolId: string) {
  const pool = getPool(poolId);
  if (!pool) throw new Error("Pool not found");
  if (pool.mode !== "replay") throw new Error("Pool is not in replay mode");
  if (pool.status === "resolved") throw new Error("Pool is already resolved");
  if (listPredictions(pool.id).length === 0) throw new Error("Cannot start replay without predictions");

  setPoolStatus(pool.id, "live", { startedAt: new Date().toISOString() });
  const events = await txlineClient.historicalEvents(pool.fixture.txlineFixtureId);
  let lastEvent = events[0];

  for (const event of events) {
    const scoreEventId = insertScoreEvent(pool, event);
    const leaderboard = rankPredictions(listPredictions(pool.id), event.homeGoals, event.awayGoals);
    insertLeaderboardSnapshot({
      poolId: pool.id,
      scoreEventId,
      homeGoals: event.homeGoals,
      awayGoals: event.awayGoals,
      snapshot: leaderboard
    });
    lastEvent = event;
  }

  return await resolvePool({
    pool,
    finalHomeGoals: lastEvent.homeGoals,
    finalAwayGoals: lastEvent.awayGoals,
    source: "historical",
    rawTxlineJson: lastEvent.raw
  });
}
