# CalledIt

Backend and smart-contract first implementation for `CalledIt_TxLINE_CFE_SPEC.md`.

## Backend

The backend is a TypeScript/Hono service with SQLite persistence using Node's built-in `node:sqlite` module.

Implemented:

- TxLINE fixture, snapshot, and historical replay adapters with opt-in demo fallback data.
- SQLite schema for users, groups, fixtures, pools, predictions, score events, leaderboard snapshots, and receipts.
- Telegram bot-only prediction flow with private inline score steppers.
- Admin-gated pool creation/replay controls, prediction submission, hidden pre-lock leaderboard, snapshots, results, receipts, and SSE snapshot endpoint.
- Telegram webhook command handling for `/start`, `/newpool`, `/leaderboard`, and `/result`.
- Shared-rank leaderboard scoring from the spec.

Run locally:

```sh
npm install
cp backend/.env.example backend/.env
npm run dev
```

Run the Telegram mini app locally:

```sh
npm run dev:frontend
```

Public deployments must set:

```sh
NODE_ENV=production
PUBLIC_MINI_APP_URL=https://your-mini-app.example
CORS_ORIGINS=https://your-mini-app.example
SESSION_SECRET=<32+ byte random secret>
ADMIN_API_KEY=<32+ byte random admin key>
POOL_INVITE_SECRET=<32+ byte random invite signing secret>
TELEGRAM_BOT_TOKEN=<telegram bot token>
TELEGRAM_WEBHOOK_SECRET=<telegram webhook secret>
TELEGRAM_INIT_MAX_AGE_SECONDS=600
TXLINE_AUTH_JWT=<guest JWT from TxLINE>
TXLINE_API_TOKEN=<activated TxLINE API token>
DEMO_MODE=false
RECEIPT_CHAIN_ENABLED=false
```

Admin HTTP routes require:

```txt
x-admin-api-key: <ADMIN_API_KEY>
```

User-facing pool routes require both a Telegram session and the signed invite token from the mini-app URL:

```txt
Authorization: Bearer <sessionToken>
x-pool-invite: <inviteToken>
```

Useful checks:

```sh
npm run typecheck
npm test
npm run demo --workspace backend
```

## External E2E Env

A blank local template is available at `backend/.env.external.local`. It is ignored by git.

For TxLINE, use one network consistently:

- Devnet API base: `https://txline-dev.txodds.com/api/`
- Mainnet API base: `https://txline.txodds.com/api/`

TxLINE data requests require both credentials:

- `TXLINE_AUTH_JWT`: guest JWT from `POST /auth/guest/start`
- `TXLINE_API_TOKEN`: activated API token from `POST /api/token/activate`

The backend uses these documented data endpoints:

- `GET /api/fixtures/snapshot`
- `GET /api/scores/snapshot/{fixtureId}`
- `GET /api/scores/historical/{fixtureId}`
- `GET /api/scores/stream`

## Public Launch Checklist

- Confirm `git status` does not include any `.env*` file.
- Keep `backend/.env.local` local-only; it is ignored by `.gitignore`.
- Rotate any token that has been copied into shared logs, screenshots, or deployment consoles.
- Set `NODE_ENV=production` and confirm startup rejects missing production secrets.
- Set `PUBLIC_MINI_APP_URL` to the deployed frontend origin and `CORS_ORIGINS` to the same origin.
- Configure the Telegram bot mini-app URL to `PUBLIC_MINI_APP_URL`.
- Use admin `POST /api/pools/:poolId/snapshot` for TxLINE-backed score writes; `GET /snapshot` is read-only.

## Smart Contract

The Anchor program in `programs/calledit_receipts` records a final receipt hash PDA for a pool. It intentionally does not implement escrow, deposits, payouts, or betting mechanics.

Implemented instruction:

- `initialize_config(authority)`
- `update_authority(new_authority)`
- `record_receipt(pool_id, txline_fixture_id, final_home_goals, final_away_goals, receipt_hash)`

`record_receipt` requires the signer to match the configured authority. For backend chain recording, set:

```sh
RECEIPT_CHAIN_ENABLED=true
SOLANA_RPC_URL=<rpc url>
SOLANA_RECEIPT_PROGRAM_ID=<program id>
SOLANA_RECEIPT_KEYPAIR_PATH=<path to backend authority keypair>
```

Verify:

```sh
cargo test --manifest-path programs/calledit_receipts/Cargo.toml
anchor build
```

## Notes

TxLINE credentials stay server-side. Demo fixtures and replay events are only used when `DEMO_MODE=true`; production fails closed with upstream errors instead of silently showing stale demo data.
