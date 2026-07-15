import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { submitMarketPrediction } from "../predictions/service.js";
import type { PoolRecord } from "../pools/repository.js";
import type { NormalizedFixture, NormalizedScoreEvent } from "../txline/client.js";
import { isFinalisedScoreEvent, txlineClient } from "../txline/client.js";
import {
  buildClaimTransaction as buildOnchainClaimTransaction,
  buildEnterPoolTransaction,
  createOnchainMarketPool,
  isMarketEnabled,
  settleWithTxlineProof,
  verifyMarketEntry
} from "./onchain.js";
import {
  completeMarketIntent,
  createMarketPool,
  createStakeIntent,
  getMarketIntent,
  getMarketPool,
  updateMarketProof
} from "./repository.js";
import { parseTxlineScoreProof } from "./txlineProof.js";

export async function createMarketPoolForFixture(input: { pool: PoolRecord; fixture: NormalizedFixture }) {
  if (!isMarketEnabled()) return null;
  const fixtureId = numericFixtureId(input.fixture.txlineFixtureId);
  const onchain = await createOnchainMarketPool({
    poolId: input.pool.id,
    txlineFixtureId: fixtureId,
    participant1IsHome: input.fixture.participant1IsHome,
    lockAt: input.pool.lockAt ?? input.fixture.kickoffAt ?? ""
  });
  return createMarketPool({
    poolId: input.pool.id,
    marketPoolAddress: onchain.marketPoolAddress,
    vaultAddress: onchain.vaultAddress,
    poolSeedHex: onchain.poolSeedHex,
    txlineFixtureId: fixtureId,
    participant1IsHome: input.fixture.participant1IsHome,
    stakeLamports: config.MARKET_STAKE_LAMPORTS,
    creationSignature: onchain.signature
  });
}

export function createStakeIntentForPrediction(input: {
  pool: PoolRecord;
  userId: string;
  homeGoals: number;
  awayGoals: number;
}) {
  if (!isMarketEnabled()) return null;
  if (!getMarketPool(input.pool.id)) throw new Error("The on-chain pool is not ready");
  const { token, intent } = createStakeIntent({
    poolId: input.pool.id,
    userId: input.userId,
    homeGoals: input.homeGoals,
    awayGoals: input.awayGoals,
    ttlSeconds: config.MARKET_INTENT_TTL_SECONDS
  });
  if (!config.PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL is not configured");
  const url = new URL(`/stake/${token}`, config.PUBLIC_BASE_URL).toString();
  return { intent, url, stakeLamports: config.MARKET_STAKE_LAMPORTS };
}

export async function buildStakeTransaction(token: string, walletAddress: string) {
  const intent = requirePendingIntent(token);
  const market = getMarketPool(intent.poolId);
  if (!market) throw new Error("The on-chain pool is not ready");
  const wallet = new PublicKey(walletAddress);
  const transaction = await buildEnterPoolTransaction({
    market,
    playerAddress: wallet.toBase58(),
    homeGoals: intent.homeGoals,
    awayGoals: intent.awayGoals
  });
  return { intent, market, ...transaction };
}

export async function confirmStakeTransaction(input: {
  token: string;
  walletAddress: string;
  entryAddress: string;
  signature: string;
}) {
  const intent = requirePendingIntent(input.token);
  const market = getMarketPool(intent.poolId);
  if (!market) throw new Error("The on-chain pool is not ready");
  new PublicKey(input.walletAddress);
  new PublicKey(input.entryAddress);
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(input.signature)) throw new Error("Transaction signature is invalid");
  const verified = await verifyMarketEntry({
    market,
    walletAddress: input.walletAddress,
    entryAddress: input.entryAddress,
    homeGoals: intent.homeGoals,
    awayGoals: intent.awayGoals,
    signature: input.signature
  });
  const prediction = submitMarketPrediction({
    poolId: intent.poolId,
    userId: intent.userId,
    predictedHomeGoals: intent.homeGoals,
    predictedAwayGoals: intent.awayGoals,
    walletAddress: input.walletAddress,
    marketEntryAddress: verified.entryAddress,
    marketEntrySignature: input.signature
  });
  const completed = completeMarketIntent({
    token: input.token,
    walletAddress: input.walletAddress,
    entryAddress: verified.entryAddress,
    signature: input.signature
  });
  return { intent: completed, prediction, market };
}

export async function buildClaimTransaction(poolId: string, walletAddress: string) {
  const market = getMarketPool(poolId);
  if (!market) throw new Error("This is not an on-chain CalledIt pool");
  const wallet = new PublicKey(walletAddress);
  return { market, ...(await buildClaimTransactionFromMarket(market, wallet.toBase58())) };
}

async function buildClaimTransactionFromMarket(market: NonNullable<ReturnType<typeof getMarketPool>>, walletAddress: string) {
  return buildOnchainClaimTransaction({ market, playerAddress: walletAddress });
}

export async function settleMarketPoolFromFinalEvent(pool: PoolRecord, event: NormalizedScoreEvent) {
  const market = getMarketPool(pool.id);
  if (!market || !isMarketEnabled()) return null;
  if (!isFinalisedScoreEvent(event)) {
    updateMarketProof({ poolId: pool.id, status: "unavailable" });
    throw new Error("Awaiting a TxLINE game_finalised score record");
  }
  if (!event.fixtureId || !event.seq) {
    updateMarketProof({ poolId: pool.id, status: "unavailable" });
    throw new Error("The final TxLINE score record is missing a fixture ID or sequence");
  }
  try {
    const response = await txlineClient.scoreStatValidation(event.fixtureId, event.seq);
    const proof = parseTxlineScoreProof(response);
    if (proof.fixtureSummary.fixtureId !== BigInt(market.txlineFixtureId)) {
      throw new Error("TxLINE proof fixture does not match the market pool");
    }
    const settlement = await settleWithTxlineProof({ market, payload: proof });
    updateMarketProof({ poolId: pool.id, status: "verified", proof: response, settlementSignature: settlement.signature });
    return { proof: response, ...settlement };
  } catch (error) {
    updateMarketProof({ poolId: pool.id, status: "failed" });
    throw error;
  }
}

export function claimUrl(poolId: string) {
  if (!config.PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL is not configured");
  return new URL(`/claim/${poolId}`, config.PUBLIC_BASE_URL).toString();
}

export function formatDevnetSol(lamports: number) {
  return `${(lamports / 1_000_000_000).toLocaleString("en-US", { maximumFractionDigits: 9 })} devnet SOL`;
}

function requirePendingIntent(token: string) {
  const intent = getMarketIntent(token);
  if (!intent) throw new Error("Stake link is invalid");
  if (intent.status === "expired") throw new Error("Stake link has expired");
  if (intent.status === "completed") throw new Error("Stake link was already completed");
  return intent;
}

function numericFixtureId(value: string) {
  if (!/^\d+$/.test(value)) throw new Error("TxLINE fixture ID is not numeric and cannot be proof-settled");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("TxLINE fixture ID is invalid");
  return parsed;
}
