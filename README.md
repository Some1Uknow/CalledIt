# CalledIt

CalledIt is a Telegram game for football score predictions.

People in a group chat pick the final score of a match before kickoff. Their picks stay hidden at first. When the match starts, CalledIt can show a live leaderboard and then produce a final result when the match ends.

This repo contains:

- a backend API
- a small Telegram mini app frontend
- an optional Solana receipt program for final result hashes

## How It Works

1. A group admin creates a pool for a match.
2. CalledIt generates a private invite link for that pool.
3. Players open the mini app from Telegram and lock in a score prediction.
4. CalledIt fetches match data from TxLINE.
5. The app shows standings and the final result.
6. Optionally, the final result hash can be recorded on Solana.

## What Is In This Repo

### Backend

The backend is a Node.js service built with Hono and SQLite.

It handles:

- Telegram authentication
- admin pool creation
- signed invite links for pools
- prediction submission
- leaderboard and result APIs
- TxLINE score fetching
- optional Solana receipt writing

### Frontend

The frontend is a small React + Vite app designed to open inside Telegram.

It handles:

- loading a pool from an invite link
- authenticating the Telegram user
- submitting a prediction
- showing leaderboard, result, and receipt screens

### Solana Program

The Solana program stores a final receipt hash for a pool.

It does not handle:

- money
- betting
- custody
- payouts

It is only for recording a final result hash when that feature is enabled.

## Run It Locally

Requirements:

- Node `>=26`
- Rust and Cargo
- Anchor tooling if you want to build the Solana program

Install dependencies:

```sh
npm install
```

Create local env:

```sh
cp backend/.env.example backend/.env
```

Run the backend:

```sh
npm run dev
```

Run the frontend:

```sh
npm run dev:frontend
```

## Important Environment Variables

The backend reads its settings from env vars.

Core production values:

```sh
NODE_ENV=production
PUBLIC_MINI_APP_URL=https://your-frontend.example
CORS_ORIGINS=https://your-frontend.example
SESSION_SECRET=<32+ byte secret>
ADMIN_API_KEY=<32+ byte secret>
POOL_INVITE_SECRET=<32+ byte secret>
TELEGRAM_BOT_TOKEN=<telegram bot token>
TELEGRAM_WEBHOOK_SECRET=<telegram webhook secret>
TELEGRAM_INIT_MAX_AGE_SECONDS=600
TXLINE_AUTH_JWT=<txline jwt>
TXLINE_API_TOKEN=<txline api token>
DEMO_MODE=false
RECEIPT_CHAIN_ENABLED=false
```

Optional Solana receipt values:

```sh
RECEIPT_CHAIN_ENABLED=true
SOLANA_RPC_URL=<rpc url>
SOLANA_RECEIPT_PROGRAM_ID=<program id>
SOLANA_RECEIPT_KEYPAIR_PATH=<path to authority keypair>
```

## Useful Commands

Run checks:

```sh
npm run typecheck
npm test
npm run build
cargo test --manifest-path programs/calledit_receipts/Cargo.toml
npm audit
```

## Security Model

- Pool links are signed with `POOL_INVITE_SECRET`.
- User-facing pool APIs require both:
  - a Telegram-backed session token
  - a valid pool invite token
- Admin-only routes require `x-admin-api-key`.
- Demo mode is blocked in production.
- The app fails closed in production if required secrets are missing.

## Public Beta Checklist

Before opening this to real users:

- deploy backend on Node `>=26`
- deploy frontend to a real public domain
- set `PUBLIC_MINI_APP_URL` and `CORS_ORIGINS` to that frontend domain
- configure the Telegram mini app URL
- configure the Telegram webhook to `/api/telegram/webhook`
- add real TxLINE credentials
- keep `backend/.env.local` out of Git
- keep `DEMO_MODE=false`

If Solana receipts are enabled:

- deploy the updated Anchor program
- initialize the receipt config authority
- make the backend signer match that authority

## Notes

- `backend/.env.local` is for local use only and should never be committed.
- `backend/.env.example` is the safe template file to keep in Git.
- The project currently assumes TxLINE as the live match data source.
