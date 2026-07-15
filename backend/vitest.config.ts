import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      DATABASE_PATH: "/tmp/calledit-test.db",
      DEMO_MODE: "false",
      TELEGRAM_BOT_TOKEN: "123456789:test-token-for-calledit-tests",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-32-bytes-long",
      TXLINE_NETWORK: "devnet",
      TXLINE_BASE_URL: "https://txline-dev.txodds.com/api/",
      TXLINE_AUTH_JWT: "test-jwt",
      TXLINE_API_TOKEN: "test-api-token",
      RECEIPT_CHAIN_ENABLED: "false"
    }
  }
});
