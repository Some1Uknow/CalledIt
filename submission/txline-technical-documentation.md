# CalledIt + TxLINE — Brief Technical Documentation

## Core idea

CalledIt turns football score predictions in Telegram groups into a live exact-score pool. A group admin selects a real fixture, players make one private score call before kickoff, and the group sees a live leaderboard. This release uses **Solana devnet** only; devnet SOL has no real-world value.

## How TxLINE powers the app

1. **Pick a real match.** CalledIt gets upcoming World Cup fixtures and kickoff times from TxLINE. The kickoff time becomes the on-chain deadline for new predictions.
2. **Keep the group live.** CalledIt listens to TxLINE's live score stream and updates the Telegram leaderboard whenever the score changes. If the stream drops, it reconnects from the last received event.
3. **Prove the final score.** After TxLINE sends its documented finalisation event, CalledIt asks for a Merkle proof of both teams' full-game goals. The CalledIt Solana program calls TxLINE's verifier on-chain before it settles the pool. The backend does not get to choose the final score.

## Business and technical highlights

- **Telegram-first:** fans use the group they already have.
- **Non-custodial:** each player reviews and signs their own fixed entry transaction; CalledIt never receives a private key.
- **Fair entry rules:** the Solana program enforces the fixed stake, one entry per wallet, and the kickoff lock.
- **Live and recoverable:** the backend persists score events, resumes the SSE feed with `Last-Event-ID`, retries with backoff, and reports TxLINE stream health on `/ready`.
- **Safe settlement:** only exact-score winners can claim. If nobody called the exact score, every entrant can claim a refund. There is no operator-withdrawal instruction.
- **Devnet scope:** the TxLINE program ID and settlement workflow are intentionally devnet-only for this beta.

## TxLINE interfaces used

All runtime data calls use the configured API base URL (`https://txline-dev.txodds.com/api/`), a Bearer guest JWT, and an `x-api-token`.

| Interface | How CalledIt uses it |
| --- | --- |
| `POST /auth/guest/start` | Starts or renews the guest JWT when TxLINE rejects an expired token. |
| `POST /api/token/activate` | One-time devnet setup: exchanges a wallet-signed TxLINE subscription for an API token. |
| `GET /fixtures/snapshot?competitionId=<id>` | Shows eligible upcoming World Cup fixtures to the group admin. |
| `GET /scores/stream` | Keeps the Telegram leaderboard in sync through Server-Sent Events; reconnects with `Last-Event-ID`. |
| `GET /scores/stat-validation?fixtureId=<id>&seq=<n>&statKeys=1,2` | Gets the Merkle proof for the two full-game goal totals used in settlement. |
| TxLINE Solana `subscribe` | One-time devnet subscription provisioning. |
| TxLINE Solana `validate_stat_v2` | Called through a CPI by CalledIt's program to verify the two score values on-chain. |

The client also includes `/scores/snapshot/:id` and `/scores/historical/:id` methods for state recovery, but the current live supervisor does not call them yet. They should not be presented as part of the active runtime flow.

## Important settlement detail

TxLINE's proof verifies the score values. CalledIt separately waits for TxLINE's `game_finalised` record (`statusId: 100`, `period: 100`) before its devnet settlement authority submits that proof. This makes the current finality step a controlled devnet workflow; a mainnet version would need a separately reviewed finality and authority design.
