import dotenv from "dotenv";
import { z } from "zod";

for (const path of ["backend/.env.local", ".env.local", "backend/.env", ".env"]) {
  dotenv.config({ path, override: false });
}

const booleanFromEnv = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .default("false")
  .transform((value) => value === "true" || value === "1" || value === "yes");

const optionalPositiveIntFromEnv = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional()
);

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_PATH: z.string().default("./calledit.db"),
  DEMO_MODE: booleanFromEnv,
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().default("CalledItBetBot"),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TXLINE_NETWORK: z.enum(["devnet", "mainnet"]).default("devnet"),
  TXLINE_BASE_URL: z.string().url().default("https://txline-dev.txodds.com/api/"),
  TXLINE_SERVICE_LEVEL: z.coerce.number().int().positive().default(1),
  TXLINE_AUTH_JWT: z.string().optional(),
  TXLINE_API_TOKEN: z.string().optional(),
  TXLINE_COMPETITION_ID: optionalPositiveIntFromEnv,
  TXLINE_USERNAME: z.string().optional(),
  TXLINE_PASSWORD: z.string().optional(),
  TXLINE_GUEST_TOKEN: z.string().optional(),
  RECEIPT_CHAIN_ENABLED: booleanFromEnv,
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_RECEIPT_PROGRAM_ID: z.string().optional(),
  SOLANA_RECEIPT_KEYPAIR_PATH: z.string().optional(),
  MARKET_ENABLED: booleanFromEnv,
  PUBLIC_BASE_URL: z.string().url().optional(),
  SOLANA_MARKET_PROGRAM_ID: z.string().optional(),
  SOLANA_MARKET_AUTHORITY_SECRET: z.string().optional(),
  SOLANA_MARKET_AUTHORITY_KEYPAIR_PATH: z.string().optional(),
  SOLANA_MARKET_SETTLEMENT_AUTHORITY: z.string().optional(),
  SOLANA_MARKET_EMERGENCY_AUTHORITY: z.string().optional(),
  SOLANA_MARKET_EMERGENCY_SECRET: z.string().optional(),
  MARKET_STAKE_LAMPORTS: z.coerce.number().int().positive().default(10_000_000),
  MARKET_MAX_ENTRIES: z.coerce.number().int().positive().max(1000).default(100),
  MARKET_INTENT_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900)
});

export const config = envSchema.parse(process.env);

const isProduction = config.NODE_ENV === "production";

if (isProduction) {
  const failures: string[] = [];
  if (!config.TELEGRAM_BOT_TOKEN) failures.push("TELEGRAM_BOT_TOKEN is required in production");
  if (config.TELEGRAM_BOT_TOKEN && !/^\d+:[A-Za-z0-9_-]{30,}$/.test(config.TELEGRAM_BOT_TOKEN)) {
    failures.push("TELEGRAM_BOT_TOKEN has an invalid format");
  }
  if (!config.TELEGRAM_WEBHOOK_SECRET || config.TELEGRAM_WEBHOOK_SECRET.length < 32) {
    failures.push("TELEGRAM_WEBHOOK_SECRET must be at least 32 characters in production");
  }
  if (!config.TXLINE_AUTH_JWT) failures.push("TXLINE_AUTH_JWT is required in production");
  if (!config.TXLINE_API_TOKEN) failures.push("TXLINE_API_TOKEN is required in production");
  if (config.DEMO_MODE) failures.push("DEMO_MODE must be false in production");
  const expectedTxlineBase =
    config.TXLINE_NETWORK === "devnet"
      ? "https://txline-dev.txodds.com/api/"
      : "https://txline.txodds.com/api/";
  if (config.TXLINE_BASE_URL !== expectedTxlineBase) {
    failures.push(`TXLINE_BASE_URL must match TXLINE_NETWORK (${expectedTxlineBase})`);
  }
  if (config.RECEIPT_CHAIN_ENABLED) {
    if (!config.SOLANA_RPC_URL) failures.push("SOLANA_RPC_URL is required when RECEIPT_CHAIN_ENABLED=true");
    if (!config.SOLANA_RECEIPT_PROGRAM_ID) {
      failures.push("SOLANA_RECEIPT_PROGRAM_ID is required when RECEIPT_CHAIN_ENABLED=true");
    }
    if (!config.SOLANA_RECEIPT_KEYPAIR_PATH) {
      failures.push("SOLANA_RECEIPT_KEYPAIR_PATH is required when RECEIPT_CHAIN_ENABLED=true");
    }
  }
  if (config.MARKET_ENABLED) {
    if (!config.PUBLIC_BASE_URL) failures.push("PUBLIC_BASE_URL is required when MARKET_ENABLED=true");
    if (!config.SOLANA_RPC_URL) failures.push("SOLANA_RPC_URL is required when MARKET_ENABLED=true");
    if (!config.SOLANA_MARKET_PROGRAM_ID) failures.push("SOLANA_MARKET_PROGRAM_ID is required when MARKET_ENABLED=true");
    if (!config.SOLANA_MARKET_AUTHORITY_SECRET && !config.SOLANA_MARKET_AUTHORITY_KEYPAIR_PATH) {
      failures.push("SOLANA_MARKET_AUTHORITY_SECRET or SOLANA_MARKET_AUTHORITY_KEYPAIR_PATH is required when MARKET_ENABLED=true");
    }
    if (!config.SOLANA_MARKET_EMERGENCY_AUTHORITY) {
      failures.push("SOLANA_MARKET_EMERGENCY_AUTHORITY is required when MARKET_ENABLED=true");
    }
  }
  if (failures.length > 0) {
    throw new Error(`Invalid production configuration: ${failures.join("; ")}`);
  }
}
