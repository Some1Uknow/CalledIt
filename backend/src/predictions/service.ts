import { randomUUID } from "node:crypto";
import { db, nowIso } from "../db/client.js";
import { getPool } from "../pools/repository.js";

export function submitPrediction(input: {
  poolId: string;
  userId: string;
  predictedHomeGoals: number;
  predictedAwayGoals: number;
}) {
  if (input.predictedHomeGoals < 0 || input.predictedHomeGoals > 9) throw new Error("Home goals must be between 0 and 9");
  if (input.predictedAwayGoals < 0 || input.predictedAwayGoals > 9) throw new Error("Away goals must be between 0 and 9");

  const now = nowIso();
  const id = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  let transactionOpen = true;
  try {
    const pool = getPool(input.poolId);
    if (!pool) throw new Error("Pool not found");
    if (pool.status !== "open" || (pool.lockAt && pool.lockAt <= now)) {
      if (pool.status === "open") {
        db.prepare("UPDATE pools SET status = 'locked', updated_at = ? WHERE id = ?").run(now, pool.id);
      }
      db.exec("COMMIT");
      transactionOpen = false;
      throw new Error("Predictions are locked for this pool");
    }
    db.prepare(
      `INSERT INTO predictions (
        id, pool_id, user_id, predicted_home_goals, predicted_away_goals,
        submitted_at, is_hidden, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, input.poolId, input.userId, input.predictedHomeGoals, input.predictedAwayGoals, now, now, now);
    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new Error("You already locked a prediction for this pool");
    }
    throw error;
  }

  return { id, submittedAt: now };
}

/**
 * Records a prediction only after the caller has independently verified its
 * matching on-chain entry PDA. Unlike the free-game path, this is deliberately
 * allowed after kickoff: the program itself enforced the lock when it accepted
 * the stake transaction.
 */
export function submitMarketPrediction(input: {
  poolId: string;
  userId: string;
  predictedHomeGoals: number;
  predictedAwayGoals: number;
  walletAddress: string;
  marketEntryAddress: string;
  marketEntrySignature: string;
}) {
  if (input.predictedHomeGoals < 0 || input.predictedHomeGoals > 9) throw new Error("Home goals must be between 0 and 9");
  if (input.predictedAwayGoals < 0 || input.predictedAwayGoals > 9) throw new Error("Away goals must be between 0 and 9");
  const now = nowIso();
  const id = randomUUID();

  db.exec("BEGIN IMMEDIATE");
  let transactionOpen = true;
  try {
    const pool = getPool(input.poolId);
    if (!pool || pool.status === "resolved" || pool.status === "cancelled") throw new Error("Pool is no longer available");

    const existing = db
      .prepare("SELECT id, wallet_address, market_entry_address FROM predictions WHERE pool_id = ? AND user_id = ?")
      .get(input.poolId, input.userId) as { id: string; wallet_address: string | null; market_entry_address: string | null } | undefined;
    if (existing) {
      if (existing.wallet_address === input.walletAddress && existing.market_entry_address === input.marketEntryAddress) {
        db.exec("COMMIT");
        transactionOpen = false;
        return { id: existing.id, submittedAt: now, duplicate: true };
      }
      throw new Error("You already locked a prediction for this pool");
    }

    db.prepare(
      `INSERT INTO predictions (
        id, pool_id, user_id, predicted_home_goals, predicted_away_goals,
        submitted_at, is_hidden, wallet_address, market_entry_address, market_entry_signature, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.poolId,
      input.userId,
      input.predictedHomeGoals,
      input.predictedAwayGoals,
      now,
      input.walletAddress,
      input.marketEntryAddress,
      input.marketEntrySignature,
      now,
      now
    );
    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new Error("That wallet already has an entry for this pool");
    }
    throw error;
  }

  return { id, submittedAt: now, duplicate: false };
}
