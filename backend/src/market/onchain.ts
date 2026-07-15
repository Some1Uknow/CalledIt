import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import { config } from "../config.js";
import type { MarketPoolRecord } from "./repository.js";

export const TXLINE_DEVNET_PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

export type TxlineProofNode = { hash: Buffer; isRightSibling: boolean };
export type TxlineScoreStat = { key: number; value: number; period: number };
export type TxlineStatLeaf = { stat: TxlineScoreStat; statProof: TxlineProofNode[] };
export type TxlineProofPayload = {
  ts: bigint;
  fixtureSummary: {
    fixtureId: bigint;
    updateStats: { updateCount: number; minTimestamp: bigint; maxTimestamp: bigint };
    eventsSubTreeRoot: Buffer;
  };
  fixtureProof: TxlineProofNode[];
  mainTreeProof: TxlineProofNode[];
  eventStatRoot: Buffer;
  stats: TxlineStatLeaf[];
};

type MarketAddresses = {
  config: PublicKey;
  pool: PublicKey;
  vault: PublicKey;
  entry?: PublicKey;
};

function marketProgramId() {
  if (!config.SOLANA_MARKET_PROGRAM_ID) throw new Error("SOLANA_MARKET_PROGRAM_ID is not configured");
  return new PublicKey(config.SOLANA_MARKET_PROGRAM_ID);
}

function rpcConnection() {
  if (!config.SOLANA_RPC_URL) throw new Error("SOLANA_RPC_URL is not configured");
  return new Connection(config.SOLANA_RPC_URL, "confirmed");
}

function authorityKeypair() {
  const secret =
    config.SOLANA_MARKET_AUTHORITY_SECRET ??
    (config.SOLANA_MARKET_AUTHORITY_KEYPAIR_PATH
      ? readFileSync(config.SOLANA_MARKET_AUTHORITY_KEYPAIR_PATH, "utf8")
      : undefined);
  if (!secret) throw new Error("SOLANA_MARKET_AUTHORITY_SECRET or SOLANA_MARKET_AUTHORITY_KEYPAIR_PATH is not configured");
  return keypairFromSecret(secret, "SOLANA_MARKET_AUTHORITY_SECRET");
}

function emergencyKeypair() {
  const authority = authorityKeypair();
  const signer = config.SOLANA_MARKET_EMERGENCY_SECRET
    ? keypairFromSecret(config.SOLANA_MARKET_EMERGENCY_SECRET, "SOLANA_MARKET_EMERGENCY_SECRET")
    : authority;
  const configured = new PublicKey(config.SOLANA_MARKET_EMERGENCY_AUTHORITY ?? authority.publicKey);
  if (!signer.publicKey.equals(configured)) {
    throw new Error("Configured emergency authority does not match the available emergency signer");
  }
  return signer;
}

function keypairFromSecret(secret: string, label: string) {
  const parsed = JSON.parse(secret) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) {
    throw new Error(`${label} must be a JSON keypair byte array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

/** Backend-only signer accessor for controlled devnet operational scripts. */
export function marketAuthorityKeypair() {
  return authorityKeypair();
}

function discriminator(namespace: "global" | "account", name: string) {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}

function u16(value: number) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

function u32(value: number) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function i32(value: number) {
  const out = Buffer.alloc(4);
  out.writeInt32LE(value);
  return out;
}

function u64(value: bigint) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function i64(value: bigint) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(value);
  return out;
}

function bool(value: boolean) {
  return Buffer.from([value ? 1 : 0]);
}

function ensureBytes32(value: Buffer, label: string) {
  if (value.length !== 32) throw new Error(`${label} must be exactly 32 bytes`);
  return value;
}

function encodeVec<T>(items: T[], encode: (item: T) => Buffer) {
  if (items.length > 256) throw new Error("Proof payload exceeds supported item count");
  return Buffer.concat([u32(items.length), ...items.map(encode)]);
}

function encodeProofNode(node: TxlineProofNode) {
  return Buffer.concat([ensureBytes32(node.hash, "proof hash"), bool(node.isRightSibling)]);
}

function encodeScoreStat(stat: TxlineScoreStat) {
  if (
    !Number.isInteger(stat.key) ||
    stat.key < 0 ||
    stat.key > 0xffff_ffff ||
    !Number.isInteger(stat.value) ||
    stat.value < -2_147_483_648 ||
    stat.value > 2_147_483_647 ||
    !Number.isInteger(stat.period) ||
    stat.period < -2_147_483_648 ||
    stat.period > 2_147_483_647
  ) {
    throw new Error("Invalid TxLINE stat");
  }
  return Buffer.concat([u32(stat.key), i32(stat.value), i32(stat.period)]);
}

function encodeTxlineProofPayload(payload: TxlineProofPayload) {
  const update = payload.fixtureSummary.updateStats;
  if (payload.ts !== update.minTimestamp) throw new Error("TxLINE proof timestamp must equal the update minimum timestamp");
  if (payload.stats.length !== 2 || payload.stats[0]?.stat.key !== 1 || payload.stats[1]?.stat.key !== 2) {
    throw new Error("TxLINE settlement proof must contain participant 1 and participant 2 total-goal stats");
  }
  return Buffer.concat([
    i64(payload.ts),
    i64(payload.fixtureSummary.fixtureId),
    i32(update.updateCount),
    i64(update.minTimestamp),
    i64(update.maxTimestamp),
    ensureBytes32(payload.fixtureSummary.eventsSubTreeRoot, "event subtree root"),
    encodeVec(payload.fixtureProof, encodeProofNode),
    encodeVec(payload.mainTreeProof, encodeProofNode),
    ensureBytes32(payload.eventStatRoot, "event stat root"),
    encodeVec(payload.stats, (leaf) => Buffer.concat([encodeScoreStat(leaf.stat), encodeVec(leaf.statProof, encodeProofNode)]))
  ]);
}

function configPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], marketProgramId())[0];
}

export function marketSeed(poolId: string) {
  return createHash("sha256").update(`calledit-market:v1:${poolId}`).digest();
}

export function deriveMarketAddresses(input: { poolSeed: Buffer; player?: PublicKey }): MarketAddresses {
  const programId = marketProgramId();
  if (input.poolSeed.length !== 32) throw new Error("Market pool seed must be 32 bytes");
  const pool = PublicKey.findProgramAddressSync([Buffer.from("pool"), input.poolSeed], programId)[0];
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), pool.toBuffer()], programId)[0];
  const entry = input.player
    ? PublicKey.findProgramAddressSync([Buffer.from("entry"), pool.toBuffer(), input.player.toBuffer()], programId)[0]
    : undefined;
  return { config: configPda(), pool, vault, entry };
}

async function sendSignerTransaction(transaction: Transaction, signer: Keypair) {
  const connection = rpcConnection();
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = signer.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  const signature = await connection.sendTransaction(transaction, [signer], { preflightCommitment: "confirmed" });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (confirmation.value.err) throw new Error(`Solana transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}

async function sendAuthorityTransaction(transaction: Transaction) {
  return sendSignerTransaction(transaction, authorityKeypair());
}

export async function initializeMarketConfig() {
  const connection = rpcConnection();
  const authority = authorityKeypair();
  const settlement = new PublicKey(config.SOLANA_MARKET_SETTLEMENT_AUTHORITY ?? authority.publicKey);
  if (!settlement.equals(authority.publicKey)) {
    throw new Error("SOLANA_MARKET_AUTHORITY_SECRET must sign for SOLANA_MARKET_SETTLEMENT_AUTHORITY");
  }
  const emergency = new PublicKey(config.SOLANA_MARKET_EMERGENCY_AUTHORITY ?? authority.publicKey);
  const configAddress = configPda();
  if (await connection.getAccountInfo(configAddress, "confirmed")) return { configAddress: configAddress.toBase58(), created: false };
  const data = Buffer.concat([
    discriminator("global", "initialize_config"),
    authority.publicKey.toBuffer(),
    settlement.toBuffer(),
    emergency.toBuffer(),
    u64(BigInt(config.MARKET_STAKE_LAMPORTS)),
    u16(config.MARKET_MAX_ENTRIES)
  ]);
  const transaction = new Transaction().add(
    new TransactionInstruction({
      programId: marketProgramId(),
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: configAddress, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data
    })
  );
  const signature = await sendAuthorityTransaction(transaction);
  return { configAddress: configAddress.toBase58(), signature, created: true };
}

export async function createOnchainMarketPool(input: {
  poolId: string;
  txlineFixtureId: number;
  participant1IsHome: boolean;
  lockAt: string;
}) {
  const authority = authorityKeypair();
  const seed = marketSeed(input.poolId);
  const addresses = deriveMarketAddresses({ poolSeed: seed });
  const lockAt = BigInt(Math.floor(Date.parse(input.lockAt) / 1_000));
  if (lockAt <= BigInt(Math.floor(Date.now() / 1_000))) throw new Error("Pool lock time must be in the future");
  const data = Buffer.concat([
    discriminator("global", "create_pool"),
    seed,
    i64(BigInt(input.txlineFixtureId)),
    bool(input.participant1IsHome),
    i64(lockAt)
  ]);
  const transaction = new Transaction().add(
    new TransactionInstruction({
      programId: marketProgramId(),
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: addresses.config, isSigner: false, isWritable: false },
        { pubkey: addresses.pool, isSigner: false, isWritable: true },
        { pubkey: addresses.vault, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data
    })
  );
  const signature = await sendAuthorityTransaction(transaction);
  return {
    marketPoolAddress: addresses.pool.toBase58(),
    vaultAddress: addresses.vault.toBase58(),
    poolSeedHex: seed.toString("hex"),
    signature
  };
}

export async function buildEnterPoolTransaction(input: {
  market: MarketPoolRecord;
  playerAddress: string;
  homeGoals: number;
  awayGoals: number;
}) {
  const player = new PublicKey(input.playerAddress);
  const poolSeed = Buffer.from(input.market.poolSeedHex, "hex");
  const addresses = deriveMarketAddresses({ poolSeed, player });
  if (addresses.pool.toBase58() !== input.market.marketPoolAddress || addresses.vault.toBase58() !== input.market.vaultAddress) {
    throw new Error("Stored market addresses do not match their PDA seeds");
  }
  const data = Buffer.concat([discriminator("global", "enter_pool"), Buffer.from([input.homeGoals, input.awayGoals])]);
  const transaction = new Transaction().add(
    new TransactionInstruction({
      programId: marketProgramId(),
      keys: [
        { pubkey: player, isSigner: true, isWritable: true },
        { pubkey: addresses.config, isSigner: false, isWritable: false },
        { pubkey: addresses.pool, isSigner: false, isWritable: true },
        { pubkey: addresses.vault, isSigner: false, isWritable: true },
        { pubkey: addresses.entry!, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data
    })
  );
  const latest = await rpcConnection().getLatestBlockhash("confirmed");
  transaction.feePayer = player;
  transaction.recentBlockhash = latest.blockhash;
  return {
    transactionBase64: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    entryAddress: addresses.entry!.toBase58(),
    lastValidBlockHeight: latest.lastValidBlockHeight
  };
}

export async function buildClaimTransaction(input: { market: MarketPoolRecord; playerAddress: string }) {
  const player = new PublicKey(input.playerAddress);
  const addresses = deriveMarketAddresses({ poolSeed: Buffer.from(input.market.poolSeedHex, "hex"), player });
  const transaction = new Transaction().add(
    new TransactionInstruction({
      programId: marketProgramId(),
      keys: [
        { pubkey: player, isSigner: true, isWritable: true },
        { pubkey: addresses.pool, isSigner: false, isWritable: true },
        { pubkey: addresses.vault, isSigner: false, isWritable: true },
        { pubkey: addresses.entry!, isSigner: false, isWritable: true }
      ],
      data: discriminator("global", "claim")
    })
  );
  const latest = await rpcConnection().getLatestBlockhash("confirmed");
  transaction.feePayer = player;
  transaction.recentBlockhash = latest.blockhash;
  return {
    transactionBase64: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    entryAddress: addresses.entry!.toBase58(),
    lastValidBlockHeight: latest.lastValidBlockHeight
  };
}

export async function verifyMarketEntry(input: {
  market: MarketPoolRecord;
  walletAddress: string;
  entryAddress: string;
  homeGoals: number;
  awayGoals: number;
  signature: string;
}) {
  const player = new PublicKey(input.walletAddress);
  const addresses = deriveMarketAddresses({ poolSeed: Buffer.from(input.market.poolSeedHex, "hex"), player });
  if (addresses.entry!.toBase58() !== input.entryAddress) throw new Error("Entry address does not match this wallet and pool");
  const connection = rpcConnection();
  const status = (await connection.getSignatureStatuses([input.signature], { searchTransactionHistory: true })).value[0];
  if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) {
    throw new Error("Stake transaction is not confirmed");
  }
  const account = await connection.getAccountInfo(addresses.entry!, "confirmed");
  if (!account || !account.owner.equals(marketProgramId())) throw new Error("On-chain entry was not found");
  const expectedDiscriminator = discriminator("account", "MarketEntry");
  if (account.data.length < 84 || !account.data.subarray(0, 8).equals(expectedDiscriminator)) {
    throw new Error("On-chain entry has an unexpected layout");
  }
  const pool = new PublicKey(account.data.subarray(8, 40));
  const entryPlayer = new PublicKey(account.data.subarray(40, 72));
  const homeGoals = account.data.readUInt8(72);
  const awayGoals = account.data.readUInt8(73);
  const stakeLamports = account.data.readBigUInt64LE(74);
  const claimed = account.data.readUInt8(82) === 1;
  if (
    !pool.equals(addresses.pool) ||
    !entryPlayer.equals(player) ||
    homeGoals !== input.homeGoals ||
    awayGoals !== input.awayGoals ||
    stakeLamports !== BigInt(input.market.stakeLamports) ||
    claimed
  ) {
    throw new Error("On-chain entry does not match the pending stake request");
  }
  return { entryAddress: addresses.entry!.toBase58() };
}

export async function settleWithTxlineProof(input: { market: MarketPoolRecord; payload: TxlineProofPayload }) {
  const authority = authorityKeypair();
  const epochDay = input.payload.ts / 86_400_000n;
  if (epochDay < 0n || epochDay > 0xffffn) throw new Error("TxLINE proof timestamp is out of range");
  const day = Buffer.alloc(2);
  day.writeUInt16LE(Number(epochDay));
  const dailyScoresMerkleRoots = PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), day],
    TXLINE_DEVNET_PROGRAM_ID
  )[0];
  const data = Buffer.concat([discriminator("global", "settle_with_txline_proof"), encodeTxlineProofPayload(input.payload)]);
  const transaction = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(
      new TransactionInstruction({
        programId: marketProgramId(),
        keys: [
          { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: configPda(), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(input.market.marketPoolAddress), isSigner: false, isWritable: true },
          { pubkey: TXLINE_DEVNET_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: dailyScoresMerkleRoots, isSigner: false, isWritable: false }
        ],
        data
      })
    );
  transaction.feePayer = authority.publicKey;
  const signature = await sendAuthorityTransaction(transaction);
  const p1 = input.payload.stats[0]!.stat.value;
  const p2 = input.payload.stats[1]!.stat.value;
  return {
    signature,
    finalHomeGoals: input.market.participant1IsHome ? p1 : p2,
    finalAwayGoals: input.market.participant1IsHome ? p2 : p1
  };
}

/** Operational emergency path: turns an open pool into individual refunds. */
export async function cancelOnchainMarketPool(market: MarketPoolRecord) {
  const emergency = emergencyKeypair();
  const addresses = deriveMarketAddresses({ poolSeed: Buffer.from(market.poolSeedHex, "hex") });
  if (addresses.pool.toBase58() !== market.marketPoolAddress) {
    throw new Error("Stored market pool address does not match its PDA seed");
  }
  const transaction = new Transaction().add(
    new TransactionInstruction({
      programId: marketProgramId(),
      keys: [
        { pubkey: emergency.publicKey, isSigner: true, isWritable: false },
        { pubkey: addresses.config, isSigner: false, isWritable: false },
        { pubkey: addresses.pool, isSigner: false, isWritable: true }
      ],
      data: discriminator("global", "cancel_pool")
    })
  );
  return sendSignerTransaction(transaction, emergency);
}

export function isMarketEnabled() {
  return config.MARKET_ENABLED;
}
