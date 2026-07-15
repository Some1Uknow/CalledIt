import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db, json, nowIso, parseJson } from "../db/client.js";

export type MarketPoolRecord = {
  poolId: string;
  marketPoolAddress: string;
  vaultAddress: string;
  poolSeedHex: string;
  txlineFixtureId: number;
  participant1IsHome: boolean;
  stakeLamports: number;
  creationSignature: string;
  proofStatus: "pending" | "verified" | "failed" | "unavailable";
  proofJson: unknown | null;
  settlementSignature: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketIntent = {
  id: string;
  poolId: string;
  userId: string;
  homeGoals: number;
  awayGoals: number;
  status: "pending" | "completed" | "expired";
  walletAddress: string | null;
  entryAddress: string | null;
  signature: string | null;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createMarketPool(input: Omit<MarketPoolRecord, "proofStatus" | "proofJson" | "settlementSignature" | "createdAt" | "updatedAt">) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO market_pools (
      pool_id, market_pool_address, vault_address, pool_seed_hex, txline_fixture_id,
      participant1_is_home, stake_lamports, creation_signature, proof_status,
      proof_json, settlement_signature, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`
  ).run(
    input.poolId,
    input.marketPoolAddress,
    input.vaultAddress,
    input.poolSeedHex,
    input.txlineFixtureId,
    input.participant1IsHome ? 1 : 0,
    input.stakeLamports,
    input.creationSignature,
    now,
    now
  );
  return getMarketPool(input.poolId)!;
}

export function getMarketPool(poolId: string): MarketPoolRecord | null {
  const row = db.prepare("SELECT * FROM market_pools WHERE pool_id = ?").get(poolId) as Record<string, unknown> | undefined;
  return row ? mapMarketPool(row) : null;
}

export function createStakeIntent(input: {
  poolId: string;
  userId: string;
  homeGoals: number;
  awayGoals: number;
  ttlSeconds: number;
}) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString();
  const id = randomUUID();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE market_intents
       SET status = 'expired', updated_at = ?
       WHERE pool_id = ? AND user_id = ? AND status = 'pending'`
    ).run(now.toISOString(), input.poolId, input.userId);
    db.prepare(
      `INSERT INTO market_intents (
        id, token_hash, pool_id, user_id, home_goals, away_goals, status,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(id, tokenHash(token), input.poolId, input.userId, input.homeGoals, input.awayGoals, expiresAt, now.toISOString(), now.toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { token, intent: getMarketIntent(token)! };
}

export function getMarketIntent(token: string): MarketIntent | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = db.prepare("SELECT * FROM market_intents WHERE token_hash = ?").get(tokenHash(token)) as Record<string, unknown> | undefined;
  if (!row) return null;
  const intent = mapIntent(row);
  if (intent.status === "pending" && intent.expiresAt <= nowIso()) {
    db.prepare("UPDATE market_intents SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), intent.id);
    return { ...intent, status: "expired" };
  }
  return intent;
}

export function completeMarketIntent(input: {
  token: string;
  walletAddress: string;
  entryAddress: string;
  signature: string;
}) {
  const intent = getMarketIntent(input.token);
  if (!intent) throw new Error("Stake link is invalid");
  if (intent.status === "expired") throw new Error("Stake link has expired");
  if (intent.status === "completed") {
    if (intent.walletAddress === input.walletAddress && intent.entryAddress === input.entryAddress) return intent;
    throw new Error("Stake link was already used");
  }
  const now = nowIso();
  db.prepare(
    `UPDATE market_intents
     SET status = 'completed', wallet_address = ?, entry_address = ?, signature = ?, completed_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`
  ).run(input.walletAddress, input.entryAddress, input.signature, now, now, intent.id);
  return getMarketIntent(input.token)!;
}

export function updateMarketProof(input: {
  poolId: string;
  status: MarketPoolRecord["proofStatus"];
  proof?: unknown;
  settlementSignature?: string | null;
}) {
  db.prepare(
    `UPDATE market_pools
     SET proof_status = ?, proof_json = COALESCE(?, proof_json), settlement_signature = COALESCE(?, settlement_signature), updated_at = ?
     WHERE pool_id = ?`
  ).run(input.status, input.proof === undefined ? null : json(input.proof), input.settlementSignature ?? null, nowIso(), input.poolId);
  return getMarketPool(input.poolId);
}

function mapMarketPool(row: Record<string, unknown>): MarketPoolRecord {
  return {
    poolId: String(row.pool_id),
    marketPoolAddress: String(row.market_pool_address),
    vaultAddress: String(row.vault_address),
    poolSeedHex: String(row.pool_seed_hex),
    txlineFixtureId: Number(row.txline_fixture_id),
    participant1IsHome: Number(row.participant1_is_home) === 1,
    stakeLamports: Number(row.stake_lamports),
    creationSignature: String(row.creation_signature),
    proofStatus: String(row.proof_status) as MarketPoolRecord["proofStatus"],
    proofJson: parseJson(String(row.proof_json ?? ""), null),
    settlementSignature: row.settlement_signature ? String(row.settlement_signature) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapIntent(row: Record<string, unknown>): MarketIntent {
  return {
    id: String(row.id),
    poolId: String(row.pool_id),
    userId: String(row.user_id),
    homeGoals: Number(row.home_goals),
    awayGoals: Number(row.away_goals),
    status: String(row.status) as MarketIntent["status"],
    walletAddress: row.wallet_address ? String(row.wallet_address) : null,
    entryAddress: row.entry_address ? String(row.entry_address) : null,
    signature: row.signature ? String(row.signature) : null,
    expiresAt: String(row.expires_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
