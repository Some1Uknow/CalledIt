import { randomUUID } from "node:crypto";
import { db, nowIso } from "../db/client.js";
import { getPool } from "../pools/repository.js";

export function submitPrediction(input: {
  poolId: string;
  userId: string;
  predictedHomeGoals: number;
  predictedAwayGoals: number;
}) {
  const pool = getPool(input.poolId);
  if (!pool) throw new Error("Pool not found");
  if (pool.status !== "open") throw new Error("Predictions are locked for this pool");
  if (input.predictedHomeGoals < 0 || input.predictedHomeGoals > 9) throw new Error("Home goals must be between 0 and 9");
  if (input.predictedAwayGoals < 0 || input.predictedAwayGoals > 9) throw new Error("Away goals must be between 0 and 9");

  const now = nowIso();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO predictions (
      id, pool_id, user_id, predicted_home_goals, predicted_away_goals,
      submitted_at, is_hidden, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, input.poolId, input.userId, input.predictedHomeGoals, input.predictedAwayGoals, now, now, now);

  return { id, submittedAt: now };
}
