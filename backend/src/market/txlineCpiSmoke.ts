import { config } from "../config.js";
import type { MarketPoolRecord } from "./repository.js";
import { createOnchainMarketPool, settleWithTxlineProof } from "./onchain.js";
import { parseTxlineScoreProof } from "./txlineProof.js";
import { txlineClient } from "../txline/client.js";

const FIXTURE_ID = "17952170";
const FINAL_SEQUENCE = "960";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (config.TXLINE_NETWORK !== "devnet") throw new Error("This CPI smoke test is limited to TxLINE devnet");
  const rawProof = await txlineClient.scoreStatValidation(FIXTURE_ID, FINAL_SEQUENCE);
  const proof = parseTxlineScoreProof(rawProof);
  if (proof.stats[0]?.stat.period !== 0 || proof.stats[1]?.stat.period !== 0) {
    throw new Error("TxLINE final proof did not provide full-game score periods");
  }

  const created = await createOnchainMarketPool({
    poolId: `txline-cpi-smoke-${Date.now()}`,
    txlineFixtureId: Number(FIXTURE_ID),
    participant1IsHome: true,
    lockAt: new Date(Date.now() + 8_000).toISOString()
  });
  const market: MarketPoolRecord = {
    poolId: `txline-cpi:${created.marketPoolAddress}`,
    marketPoolAddress: created.marketPoolAddress,
    vaultAddress: created.vaultAddress,
    poolSeedHex: created.poolSeedHex,
    txlineFixtureId: Number(FIXTURE_ID),
    participant1IsHome: true,
    stakeLamports: config.MARKET_STAKE_LAMPORTS,
    creationSignature: created.signature,
    proofStatus: "pending",
    proofJson: null,
    settlementSignature: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await delay(10_000);
  const settled = await settleWithTxlineProof({ market, payload: proof });
  if (settled.finalHomeGoals !== 1 || settled.finalAwayGoals !== 1) {
    throw new Error("TxLINE proof did not settle the expected final score");
  }
  console.log(
    JSON.stringify({
      network: "devnet",
      fixtureId: FIXTURE_ID,
      sequence: FINAL_SEQUENCE,
      marketPoolAddress: market.marketPoolAddress,
      settlementSignature: settled.signature,
      finalHomeGoals: settled.finalHomeGoals,
      finalAwayGoals: settled.finalAwayGoals,
      cpiVerified: true
    })
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "TxLINE CPI smoke test failed");
  process.exitCode = 1;
});
