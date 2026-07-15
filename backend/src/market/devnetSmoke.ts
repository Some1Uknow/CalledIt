import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { config } from "../config.js";
import type { MarketPoolRecord } from "./repository.js";
import {
  buildClaimTransaction,
  buildEnterPoolTransaction,
  cancelOnchainMarketPool,
  createOnchainMarketPool,
  marketAuthorityKeypair,
  verifyMarketEntry
} from "./onchain.js";

const VAULT_SPACE = 8 + 32 + 1;

async function sendPreparedTransaction(input: { transactionBase64: string; lastValidBlockHeight: number }, connection: Connection) {
  const signer = marketAuthorityKeypair();
  const transaction = Transaction.from(Buffer.from(input.transactionBase64, "base64"));
  if (!transaction.recentBlockhash) throw new Error("Prepared transaction has no blockhash");
  transaction.partialSign(signer);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: "confirmed" });
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash: transaction.recentBlockhash, lastValidBlockHeight: input.lastValidBlockHeight },
    "confirmed"
  );
  if (confirmation.value.err) throw new Error(`Prepared transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}

async function main() {
  if (config.TXLINE_NETWORK !== "devnet") throw new Error("This smoke test is limited to devnet");
  if (!config.SOLANA_RPC_URL) throw new Error("SOLANA_RPC_URL is required");
  const signer = marketAuthorityKeypair();
  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  const created = await createOnchainMarketPool({
    poolId: `devnet-smoke-${Date.now()}`,
    txlineFixtureId: 1,
    participant1IsHome: true,
    lockAt: new Date(Date.now() + 10 * 60_000).toISOString()
  });
  const market: MarketPoolRecord = {
    poolId: `smoke:${created.marketPoolAddress}`,
    marketPoolAddress: created.marketPoolAddress,
    vaultAddress: created.vaultAddress,
    poolSeedHex: created.poolSeedHex,
    txlineFixtureId: 1,
    participant1IsHome: true,
    stakeLamports: config.MARKET_STAKE_LAMPORTS,
    creationSignature: created.signature,
    proofStatus: "pending",
    proofJson: null,
    settlementSignature: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const entry = await buildEnterPoolTransaction({
    market,
    playerAddress: signer.publicKey.toBase58(),
    homeGoals: 1,
    awayGoals: 0
  });
  const entrySignature = await sendPreparedTransaction(entry, connection);
  await verifyMarketEntry({
    market,
    walletAddress: signer.publicKey.toBase58(),
    entryAddress: entry.entryAddress,
    homeGoals: 1,
    awayGoals: 0,
    signature: entrySignature
  });
  const cancelSignature = await cancelOnchainMarketPool(market);
  const claim = await buildClaimTransaction({ market, playerAddress: signer.publicKey.toBase58() });
  const claimSignature = await sendPreparedTransaction(claim, connection);
  const vault = await connection.getAccountInfo(new PublicKey(market.vaultAddress), "confirmed");
  const expectedRent = await connection.getMinimumBalanceForRentExemption(VAULT_SPACE, "confirmed");
  if (!vault || vault.lamports !== expectedRent) {
    throw new Error("Refund smoke test did not return the stake to the player");
  }
  console.log(
    JSON.stringify({
      network: "devnet",
      marketPoolAddress: market.marketPoolAddress,
      entrySignature,
      cancelSignature,
      claimSignature,
      refundVerified: true
    })
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Devnet smoke test failed");
  process.exitCode = 1;
});
