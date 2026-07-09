import { createHash, randomUUID } from "node:crypto";
import { db, json, nowIso, parseJson } from "../db/client.js";
import { rankPredictions } from "../leaderboard/algorithm.js";
import { listPredictions, type PoolRecord, setPoolStatus } from "../pools/repository.js";
import { config } from "../config.js";
import { recordReceiptOnChain } from "./onchain.js";

export function receiptHash(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function resolvePool(input: {
  pool: PoolRecord;
  finalHomeGoals: number;
  finalAwayGoals: number;
  source: "snapshot" | "stream" | "historical" | "stat_validation";
  proofJson?: unknown;
  rawTxlineJson?: unknown;
}) {
  const ranked = rankPredictions(listPredictions(input.pool.id), input.finalHomeGoals, input.finalAwayGoals);
  const winningDistance = ranked[0]?.distance ?? null;
  const now = nowIso();

  const updatePrediction = db.prepare("UPDATE predictions SET final_distance = ?, rank = ?, updated_at = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const prediction of ranked) {
      updatePrediction.run(prediction.distance, prediction.rank, now, prediction.id);
    }
    setPoolStatus(input.pool.id, "resolved", {
      resolvedAt: now,
      finalHomeGoals: input.finalHomeGoals,
      finalAwayGoals: input.finalAwayGoals,
      winningDistance
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const receiptPayload = {
    fixture: `${input.pool.fixture.homeTeam} vs ${input.pool.fixture.awayTeam}`,
    txlineFixtureId: input.pool.fixture.txlineFixtureId,
    finalHomeGoals: input.finalHomeGoals,
    finalAwayGoals: input.finalAwayGoals,
    source: input.source,
    resolvedAt: now,
    winners: ranked.filter((entry) => entry.distance === winningDistance).map((entry) => entry.displayName)
  };
  const hash = receiptHash(receiptPayload);

  db.prepare(
    `INSERT INTO receipts (
      id, pool_id, txline_fixture_id, final_home_goals, final_away_goals, source,
      proof_json, raw_txline_json, receipt_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pool_id) DO UPDATE SET
      final_home_goals = excluded.final_home_goals,
      final_away_goals = excluded.final_away_goals,
      source = excluded.source,
      proof_json = excluded.proof_json,
      raw_txline_json = excluded.raw_txline_json,
      receipt_hash = excluded.receipt_hash,
      created_at = excluded.created_at`
  ).run(
    randomUUID(),
    input.pool.id,
    input.pool.fixture.txlineFixtureId,
    input.finalHomeGoals,
    input.finalAwayGoals,
    input.source,
    input.proofJson === undefined ? null : json(input.proofJson),
    input.rawTxlineJson === undefined ? null : json(input.rawTxlineJson),
    hash,
    now
  );

  const chainReceipt = await recordReceiptOnChain({
    poolId: input.pool.id,
    txlineFixtureId: input.pool.fixture.txlineFixtureId,
    finalHomeGoals: input.finalHomeGoals,
    finalAwayGoals: input.finalAwayGoals,
    receiptHash: hash
  });

  return {
    receipt: receiptPayload,
    receiptHash: hash,
    chainReceipt,
    ranked: ranked.map((entry) => ({ ...entry, finalDistance: entry.distance, rank: entry.rank }))
  };
}

export function getReceipt(poolId: string) {
  const row = db.prepare("SELECT * FROM receipts WHERE pool_id = ?").get(poolId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    poolId: String(row.pool_id),
    txlineFixtureId: String(row.txline_fixture_id),
    finalHomeGoals: Number(row.final_home_goals),
    finalAwayGoals: Number(row.final_away_goals),
    source: String(row.source),
    proofJson: parseJson(String(row.proof_json ?? ""), null),
    rawTxlineJson: parseJson(String(row.raw_txline_json ?? ""), null),
    receiptHash: row.receipt_hash ? String(row.receipt_hash) : null,
    chainStatus: config.RECEIPT_CHAIN_ENABLED ? "unavailable" : "disabled",
    createdAt: String(row.created_at)
  };
}
