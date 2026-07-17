# CalledIt

CalledIt is a Telegram bot for live football score predictions. In the devnet market mode, a group admin creates a fixed-stake exact-score pool, players fund their entry from their own Solana wallet, and TxLINE settles the final score using an on-chain Merkle proof.

## Beta flow

1. Add the bot to a Telegram group and grant it permission to read membership and edit its messages.
2. A group admin runs `/newpool` and chooses an upcoming World Cup fixture.
3. Members follow the private prediction link, choose one exact score, and fund their devnet SOL entry before kickoff.
4. The on-chain program locks entries automatically at kickoff.
5. The bot edits the group leaderboard as TxLINE devnet score events arrive.
6. TxLINE validates the final full-game score on-chain. Exact-score winners claim the pot; no exact winner or an emergency cancellation enables individual refunds.

There is no Telegram Mini App and CalledIt never receives a player private key. The hosted wallet page only prepares a fixed program transaction for the connected wallet to review and sign. This deployment is devnet-only: devnet SOL has no real-world value. Mainnet is deliberately out of scope pending a separate audit, legal review, and multisig authority setup.

## How TxLINE powers the backend

- Provides real fixtures and kickoff times for new pools.
- Streams live scores to update the Telegram leaderboard.
- Reconnects from the last event if the score stream drops.
- Provides a final-score proof for both teams' full-game goals.
- Lets the Solana program verify the proof before settlement, so the backend cannot choose the final score.

## TxLINE API feedback

- **What we liked**
  - One API provides fixtures, live scores, and an on-chain proof.
  - Settlement does not rely on trusting our backend.
- **Where we hit friction**
  - Expiring guest tokens required retry and renewal logic.
  - Participant scores had to be mapped to home and away teams.
  - A proven score still needs a final-match event before settlement.

## Public HTTP surface

- `GET /health` — process liveness
- `GET /ready` — SQLite and TxLINE supervisor status
- `POST /api/telegram/webhook` — Telegram updates authenticated by `TELEGRAM_WEBHOOK_SECRET`
- `GET /stake/:token` and `GET /claim/:poolId` — one-purpose wallet pages, enabled only when `MARKET_ENABLED=true`
- `POST /api/market/*` — bearer-link-scoped transaction preparation and confirmation endpoints, enabled only when `MARKET_ENABLED=true`

No HTTP admin endpoints are mounted in production.

## Requirements

- Node.js 26 or newer
- A Telegram bot token and webhook secret
- TxLINE devnet guest JWT and API token from the same devnet subscription
- One persistent filesystem volume for SQLite
- A deployed CalledIt escrow program on Solana devnet and a backend-only devnet authority key

## Configuration

Copy `backend/.env.example` to `backend/.env.local` for local development. A public deployment must still use `NODE_ENV=production`, even though TxLINE runs on devnet.

Required production values:

```sh
NODE_ENV=production
PORT=8787
DATABASE_PATH=/data/calledit.db
DEMO_MODE=false
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_BOT_USERNAME=<bot username without @>
TELEGRAM_WEBHOOK_SECRET=<random 32+ byte secret>
TXLINE_NETWORK=devnet
TXLINE_BASE_URL=https://txline-dev.txodds.com/api/
TXLINE_SERVICE_LEVEL=1
TXLINE_AUTH_JWT=<devnet guest JWT>
TXLINE_API_TOKEN=<devnet API token>
RECEIPT_CHAIN_ENABLED=false
MARKET_ENABLED=true
PUBLIC_BASE_URL=https://<public-backend>
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_MARKET_PROGRAM_ID=2Yr85XfdHiYHyjxWFkVJzPiL9xfKYx3w3vGw4eqcwMMM
SOLANA_MARKET_AUTHORITY_SECRET=<JSON keypair secret stored only in Railway>
SOLANA_MARKET_EMERGENCY_AUTHORITY=<emergency public key>
MARKET_STAKE_LAMPORTS=10000000
MARKET_MAX_ENTRIES=100
MARKET_INTENT_TTL_SECONDS=900
```

The TxLINE guest JWT may expire while the service is running; CalledIt renews it on a rejected API/SSE request. Production validation therefore requires an initial JWT and API token but does not require a long remaining JWT lifetime.

## Commands

```sh
npm install
npm run dev
npm run typecheck
npm test
npm run build
cargo test --manifest-path programs/calledit_receipts/Cargo.toml
npm audit
cargo audit
```

## Telegram setup

Configure Telegram to send updates to:

```txt
https://<public-backend>/api/telegram/webhook
```

Set the same random secret in Telegram's `secret_token` webhook option and `TELEGRAM_WEBHOOK_SECRET`. The bot must be able to call `getChatMember`, send messages, and edit its own messages.

## Storage and operations

Run exactly one backend instance for the SQLite beta. Mount `DATABASE_PATH` on persistent storage, create encrypted hourly backups with seven-day retention, and test restoration before launch. `/ready` reports database readiness and whether the TxLINE stream is connected; a disconnected stream is degraded state rather than process failure.

The included container uses `/data/calledit.db` on the `calledit-data` volume. Generate a base64-encoded 32-byte backup key in your secret manager, then schedule:

```sh
DATABASE_PATH=/data/calledit.db BACKUP_DIR=/backups BACKUP_ENCRYPTION_KEY=<secret> npm run backup
DATABASE_PATH=/tmp/calledit-restore-test.db BACKUP_ENCRYPTION_KEY=<secret> npm run restore -- /backups/<backup>.db.enc
```

The backup command takes a consistent SQLite snapshot, encrypts it with AES-256-GCM, writes it atomically, and removes backups older than `BACKUP_RETENTION_DAYS` (seven by default). The restore command refuses to overwrite a database and runs SQLite integrity validation before publishing the restored file.

For the included Compose definition, export only the required values or pass an environment file explicitly:

```sh
docker compose --env-file backend/.env.local up --build
```

Compose allowlists the bot and TxLINE settings instead of copying every local variable into the container.

## Security notes

- Join codes are random, stored only as hashes, expire at kickoff, and are accepted only from members of the originating Telegram group.
- Telegram updates are size-limited, schema-validated, authenticated, and deduplicated by `update_id`.
- On-chain entries enforce the fixed stake, one entry per wallet, canonical PDAs, and kickoff lock. Program-owned PDA vaults can pay only a winner or the originating entrant in refund mode; there is no operator withdrawal instruction.
- Final market scores require TxLINE's `validate_stat_v2` Merkle proof for exact participant 1/2 full-game goal leaves. The backend also accepts only TxLINE's documented `game_finalised` record before relaying the proof.
- Predictions enforce kickoff inside an immediate SQLite transaction for the non-market path.
- TxLINE and Telegram credentials remain server-side and must never be committed.
- `backend/.env.local` is ignored by Git.

## Beta launch checklist

- Keep `MARKET_ENABLED=false` until the program ID, devnet authority secret, public URL, and emergency authority are all configured.
- Verify the devnet program configuration and run `npm run market:smoke-devnet` plus `npm run market:smoke-txline-cpi-devnet` before first use.
- Rotate the Telegram bot token, webhook secret, TxLINE guest JWT, and TxLINE API token used during development.
- Deploy exactly one backend instance with a persistent `/data` volume.
- Register the production HTTPS webhook with Telegram's `secret_token` set.
- Run one encrypted backup and restore drill against the deployed volume.
- Confirm `/health` is healthy and `/ready` can observe the TxLINE stream during a covered fixture window.
