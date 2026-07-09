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
  PUBLIC_MINI_APP_URL: z.string().url().default("https://calledit.example"),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:8787"),
  SESSION_SECRET: z.string().min(32).default("dev-session-secret-change-me-32-bytes"),
  ADMIN_API_KEY: z.string().min(32).optional(),
  POOL_INVITE_SECRET: z.string().min(32).default("dev-pool-invite-secret-change-me-32"),
  DEMO_MODE: booleanFromEnv,
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().default("CalledItBetBot"),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_INIT_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(600),
  TXLINE_BASE_URL: z.string().url().default("https://txline-dev.txodds.com/api/"),
  TXLINE_AUTH_JWT: z.string().optional(),
  TXLINE_API_TOKEN: z.string().optional(),
  TXLINE_COMPETITION_ID: optionalPositiveIntFromEnv,
  TXLINE_USERNAME: z.string().optional(),
  TXLINE_PASSWORD: z.string().optional(),
  TXLINE_GUEST_TOKEN: z.string().optional(),
  RECEIPT_CHAIN_ENABLED: booleanFromEnv,
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_RECEIPT_PROGRAM_ID: z.string().optional(),
  SOLANA_RECEIPT_KEYPAIR_PATH: z.string().optional()
});

export const config = envSchema.parse(process.env);

const isProduction = config.NODE_ENV === "production";

if (isProduction) {
  const failures: string[] = [];
  if (!config.TELEGRAM_BOT_TOKEN) failures.push("TELEGRAM_BOT_TOKEN is required in production");
  if (!config.TELEGRAM_WEBHOOK_SECRET) failures.push("TELEGRAM_WEBHOOK_SECRET is required in production");
  if (!config.ADMIN_API_KEY) failures.push("ADMIN_API_KEY is required in production");
  if (!config.TXLINE_AUTH_JWT) failures.push("TXLINE_AUTH_JWT is required in production");
  if (!config.TXLINE_API_TOKEN) failures.push("TXLINE_API_TOKEN is required in production");
  if (config.SESSION_SECRET === "dev-session-secret-change-me-32-bytes") {
    failures.push("SESSION_SECRET must be changed in production");
  }
  if (config.POOL_INVITE_SECRET === "dev-pool-invite-secret-change-me-32") {
    failures.push("POOL_INVITE_SECRET must be changed in production");
  }
  if (config.PUBLIC_MINI_APP_URL === "https://calledit.example") {
    failures.push("PUBLIC_MINI_APP_URL must be set in production");
  }
  if (config.DEMO_MODE) failures.push("DEMO_MODE must be false in production");
  if (config.RECEIPT_CHAIN_ENABLED) {
    if (!config.SOLANA_RPC_URL) failures.push("SOLANA_RPC_URL is required when RECEIPT_CHAIN_ENABLED=true");
    if (!config.SOLANA_RECEIPT_PROGRAM_ID) {
      failures.push("SOLANA_RECEIPT_PROGRAM_ID is required when RECEIPT_CHAIN_ENABLED=true");
    }
    if (!config.SOLANA_RECEIPT_KEYPAIR_PATH) {
      failures.push("SOLANA_RECEIPT_KEYPAIR_PATH is required when RECEIPT_CHAIN_ENABLED=true");
    }
  }
  if (failures.length > 0) {
    throw new Error(`Invalid production configuration: ${failures.join("; ")}`);
  }
}

export const corsOrigins = config.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
