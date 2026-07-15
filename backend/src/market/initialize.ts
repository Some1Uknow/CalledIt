import { config } from "../config.js";
import { initializeMarketConfig } from "./onchain.js";

async function main() {
  if (config.TXLINE_NETWORK !== "devnet") {
    throw new Error("This initializer is intentionally limited to TxLINE devnet");
  }
  const result = await initializeMarketConfig();
  console.log(JSON.stringify({ network: "devnet", ...result }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Market configuration initialization failed");
  process.exitCode = 1;
});
