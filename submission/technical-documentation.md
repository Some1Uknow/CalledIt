# Brief Technical Documentation

## Core idea

CalledIt is a Telegram bot that turns football predictions into private, friend-to-friend exact-score pools. It is designed for groups that already discuss a match together: an admin creates a pool, each player privately locks one score before kickoff, and the group sees a live leaderboard as the match progresses.

The current release is a Solana devnet beta. Devnet SOL has no real-world value, and CalledIt does not receive or store player private keys.

## How the product works

1. A Telegram group admin runs `/newpool` and selects an upcoming football fixture.
2. CalledIt creates a private prediction link for members of that group. Each player chooses one exact score and reviews a fixed-stake transaction in their own wallet.
3. The CalledIt Solana program accepts one entry per wallet and rejects entries after the fixture kickoff time. Player funds are held in a program-controlled pool vault.
4. During the match, TxLINE score events update the Telegram leaderboard. Predictions remain private before kickoff.
5. After the match, CalledIt requests TxLINE's final-score proof. The Solana program verifies the proof through a CPI before settlement. Exact-score winners can claim the pool; if nobody called the exact score, entrants can claim refunds.

## Business highlights

- **Telegram-first distribution:** the product runs inside existing football groups instead of asking fans to build a new social network.
- **Social competition:** players compete with friends and group members, not an anonymous global market.
- **Simple exact-score mechanic:** one private score call before kickoff is easier to understand than trading changing probabilities or managing an order book.
- **Fixed-stake pool:** every entry uses the same configured amount, and the pool is paid to exact-score winners or refunded when there is no exact winner.
- **Non-custodial:** players connect their own wallet and sign their own transaction. CalledIt never receives a private key.
- **Current commercial scope:** the beta uses devnet SOL and charges no fee. A separate mainnet release would require an audit, legal review, and multisig authority setup before introducing real-value funds or a platform fee.

## Technical highlights

- **Backend:** TypeScript service with SQLite persistence for fixtures, pools, entries, score events, and settlement receipts.
- **Live match state:** the backend consumes TxLINE Server-Sent Events, stores the latest event, reconnects with `Last-Event-ID`, and renews the guest JWT after an authentication failure.
- **On-chain entry controls:** the Solana program enforces the fixed stake, one entry per wallet, canonical pool accounts, and the kickoff lock.
- **Proof-backed settlement:** the backend cannot select the winning score. TxLINE returns a Merkle proof for the two full-game goal values, and CalledIt's program invokes TxLINE's `validate_stat_v2` instruction through CPI.
- **Finality gate:** a proof verifies score values, while CalledIt separately waits for TxLINE's documented `game_finalised` record with `statusId: 100` and `period: 100` before submitting settlement on devnet.
- **Safety:** the program has winner-claim and refund paths but no operator-withdrawal instruction. The public deployment is devnet-only until separate production reviews are complete.

## TxLINE endpoints and interfaces used

Runtime data uses the configured devnet base URL `https://txline-dev.txodds.com/api/`, a Bearer guest JWT, and an `x-api-token`. Guest authentication and token activation use the TxLINE devnet host `https://txline-dev.txodds.com`.

### Active runtime endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `https://txline-dev.txodds.com/api/fixtures/snapshot?competitionId=<id>` | Loads upcoming fixtures, teams, kickoff times, and fixture IDs for pool creation. |
| `GET` | `https://txline-dev.txodds.com/api/scores/stream` | Opens the live Server-Sent Events stream used to update Telegram leaderboards. The client sends `Last-Event-ID` when reconnecting. |
| `GET` | `https://txline-dev.txodds.com/api/scores/stat-validation?fixtureId=<id>&seq=<n>&statKeys=1,2` | Requests the Merkle proof for the two full-game goal totals used by settlement. |
| `POST` | `https://txline-dev.txodds.com/auth/guest/start` | Obtains or renews the guest JWT. Called again when an authenticated TxLINE request or stream returns `401`. |

### Setup and recovery endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `https://txline-dev.txodds.com/api/token/activate` | Exchanges a wallet-signed TxLINE subscription transaction for the API token used by the backend. |
| `GET` | `https://txline.txodds.com/documentation/programs/devnet.md` | Fetches the TxLINE devnet program IDL for the activation and smoke-test script. |
| `GET` | `https://txline-dev.txodds.com/api/scores/snapshot/<fixtureId>` | Client method for recovering the current state of a match. |
| `GET` | `https://txline-dev.txodds.com/api/scores/historical/<fixtureId>` | Client method for replaying missed score events during recovery. |

### TxLINE Solana program interfaces

- `subscribe` provisions the TxLINE devnet service subscription during setup.
- `validate_stat_v2` is invoked by the CalledIt Solana program through CPI to verify the final home and away goal values from the TxLINE proof.

The active live supervisor uses the fixture snapshot, score stream, guest-token renewal, and stat-validation endpoints. Snapshot and historical methods are implemented for recovery support but are not part of the normal live stream path.
