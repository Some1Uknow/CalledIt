# CalledIt: Live World Cup Score-Prediction Rooms for Telegram

## 1. Product Summary

CalledIt is a Telegram-native World Cup fan game where a group chat predicts the exact score of a match before kickoff, then watches a live leaderboard update as TxLINE score data changes the state of the game.

Instead of a spreadsheet, admin, or betting app, one person creates a pool in a Telegram group, friends submit hidden score predictions through a Mini App, and TxLINE live/replay match data decides who is currently closest and who finally "called it".

The product is deliberately not a sportsbook, not a prediction market, and not a fantasy sports clone. It is a lightweight group-chat game for football fans.

Recommended MVP:

- Telegram bot for pool creation and group announcements.
- Telegram Mini App for prediction entry, live leaderboard, and result receipt.
- Backend that consumes TxLINE fixtures, score snapshots, live/replay score updates, and optional final-score proof/validation.
- Free-to-play scoring only for the core hackathon demo.
- Optional Solana usage only as a stretch for badges, receipts, or private escrow after the core fan loop works.

## 2. Product Positioning

CalledIt is:

> A live score-prediction game for Telegram football groups, where TxLINE decides who really called the match.

It should feel like:

- A football group-chat game.
- A better version of everyone saying "2-1" before kickoff.
- A live bragging-rights board during the match.
- A no-admin replacement for Google Sheets prediction pools.

It should not feel like:

- A crypto app.
- A sportsbook.
- A parlay builder.
- A fantasy sports dashboard.
- A generic live-score app.
- A proof-of-concept oracle demo.

## 3. Real Fan Problem

Football fans already predict scores in WhatsApp, Telegram, Discord, office groups, and fan communities. The annoying part is that the predictions get buried, copied, forgotten, or manually tracked in spreadsheets. During the match, nobody knows whose prediction is currently closest. After full time, someone still has to check the final score, compare guesses, calculate the winner, and post the result.

CalledIt removes the manual admin and turns the prediction into live group-chat drama.

## 4. Target Users

Primary users:

- Telegram football group chats.
- Friend groups watching World Cup games together or remotely.
- Office / college World Cup prediction groups.
- Small fan communities that already do informal score predictions.
- Creators who want simple matchday interaction without running a gambling product.

Secondary users:

- Pub / watch-party hosts.
- Telegram sports communities.
- Football content pages that want a lightweight game link for followers.

Non-target users for MVP:

- Professional bettors.
- Odds traders.
- Fantasy football power users.
- Prediction market users.
- Users seeking financial upside.

## 5. Why Users Would Care

Users already care about:

- Saying "I called it" before the match.
- Proving they predicted the score correctly.
- Beating friends in a group chat.
- Seeing the group react when a goal changes everything.
- Avoiding spreadsheets and manual admin.
- Sharing a simple result card after the match.

The key emotional loop is not money. It is bragging rights.

## 6. Core User Flow

### Pool creation

1. User opens a Telegram group.
2. User types `/newpool`.
3. Bot fetches upcoming/replayable fixtures from TxLINE.
4. Bot shows a short match picker.
5. User selects one fixture.
6. Bot posts a group message:
   - fixture name
   - kickoff time / replay label
   - prediction lock rule
   - "Predict Now" button

### Prediction submission

1. Group member taps "Predict Now".
2. Telegram Mini App opens inside Telegram.
3. User sees match, lock time, and current participant count.
4. User selects exact score using two steppers:
   - home goals
   - away goals
5. User taps "Lock prediction".
6. Mini App confirms submission.
7. Prediction stays hidden from the group until kickoff/lock.

### During match

1. Backend consumes TxLINE score stream or replay events.
2. Live score updates in the Mini App.
3. Each user receives a live distance score:
   - `distance = abs(predicted_home - current_home) + abs(predicted_away - current_away)`
4. The closest prediction ranks first.
5. When a goal changes the leaderboard, the UI highlights it.
6. Bot posts only major updates, not spam:
   - kickoff
   - goal causing leaderboard flip
   - half-time leader
   - full-time result

### Final whistle

1. Backend fetches final score snapshot / validation data from TxLINE.
2. App calculates final distance for every prediction.
3. Exact score wins first.
4. If nobody is exact, closest score wins.
5. Ties are shared winners by default.
6. Bot posts result in Telegram group.
7. Mini App shows receipt page.
8. User can share a result card.

## 7. MVP Scope

Build the smallest product that proves the fan loop:

- Telegram bot.
- Telegram Mini App.
- Fixture picker powered by TxLINE.
- Create one match pool.
- Join pool from group message.
- Submit one exact-score prediction.
- Hide predictions until lock.
- Live/replay score updates from TxLINE.
- Live closest-score leaderboard.
- Final winner calculation.
- Result announcement back into Telegram.
- TxLINE-powered receipt page.
- Historical replay fallback for demo.

Explicitly out of scope for core MVP:

- Real-money pools.
- Solana escrow.
- Parlay cards.
- Odds-based payouts.
- Public liquidity.
- AMM/orderbook.
- Complex fantasy scoring.
- Player-level predictions.
- Native mobile app.
- Wallet onboarding.
- Creator monetization.
- Multiple sports.
- Multiple prediction types in the first demo.

## 8. Product Rules

### Prediction rule

Each participant predicts:

- home team final goals
- away team final goals

Example:

```txt
Argentina 2 - 1 France
```

### Lock rule

Default MVP lock:

- predictions lock at kickoff.

Demo-friendly lock:

- creator can manually start replay/lock predictions.

### Live ranking rule

During match/replay:

```txt
distance = abs(predicted_home - live_home) + abs(predicted_away - live_away)
```

Lower distance ranks higher.

Example:

Actual live score: `1 - 0`

| Prediction | Distance |
|---|---:|
| 1-0 | 0 |
| 2-1 | 2 |
| 0-0 | 1 |
| 3-2 | 4 |

### Final winning rule

At full time:

1. Exact score wins.
2. If no exact score exists, lowest distance wins.
3. If multiple users have the same lowest distance, all are winners.
4. Optional tie-breaker stretch: earliest submitted prediction.

MVP default should be shared winners. It is friendlier and simpler.

## 9. Why TxLINE

TxLINE is not decoration in this product. It powers the core experience.

TxLINE is used for:

- fixture selection
- match identity
- live score updates
- replay mode
- reconnect snapshots
- final score resolution
- optional proof/receipt

Without TxLINE, CalledIt is just a static prediction form. With TxLINE, the group can watch the prediction leaderboard move as the match unfolds.

## 10. TxLINE Integration

Base API targets from the existing TxLINE docs/spec:

- Mainnet: `https://txline.txodds.com/api/`
- Devnet: `https://txline-dev.txodds.com/api/`

Authentication:

- Start guest session with TxLINE auth.
- Store JWT/API token server-side.
- Never expose TxLINE credentials directly in the Mini App.

Required data flows:

### Fixtures

Used for:

- `/newpool` match picker
- fixture metadata
- team names
- kickoff time
- fixture ID stored in pool

Backend endpoint:

```txt
GET /api/fixtures/upcoming
GET /api/fixtures/replayable
```

Internal behavior:

- fetch TxLINE fixtures
- filter to World Cup fixtures
- return short list to Telegram bot

### Score snapshot

Used for:

- initial room load
- reconnect state
- final state sanity check

Backend endpoint:

```txt
GET /api/pools/:poolId/snapshot
```

Internal behavior:

- fetch latest TxLINE score snapshot for fixture
- normalize into app score model
- recalculate leaderboard

### Live score stream

Used for:

- live match updates
- live leaderboard movement
- goal-triggered bot messages

Backend behavior:

- connect to TxLINE SSE score stream server-side
- filter events by fixture ID
- normalize events
- persist score events
- broadcast to Mini App clients using WebSocket or SSE

App endpoint:

```txt
GET /api/pools/:poolId/events
```

or

```txt
WS /api/pools/:poolId/live
```

### Historical replay

Used for:

- guaranteed demo even when no live match is active
- deterministic test runs
- judge review after submission deadline

Backend behavior:

- fetch TxLINE historical score sequence for a fixture
- replay events at configurable speed
- broadcast same normalized event format as live mode

App endpoint:

```txt
POST /api/pools/:poolId/replay/start
POST /api/pools/:poolId/replay/pause
POST /api/pools/:poolId/replay/reset
```

### Final validation / receipt

Used for:

- result page
- judge-facing technical trust
- optional future on-chain use

Backend behavior:

- fetch final score snapshot or stat-validation proof
- store result metadata
- attach receipt to pool result

Receipt should be plain:

```txt
Fixture: Argentina vs France
Final score: 2 - 1
Source: TxLINE
Resolved at: <timestamp>
Fixture ID: <fixtureId>
Receipt ID: <internal id>
```

Do not make normal users read proof data.

## 11. Screens

### 1. Telegram group message

Purpose:

- entry point
- no separate app discovery needed

Content:

```txt
⚽ Argentina vs France
Predict the final score before kickoff.

5 friends joined.
Predictions lock at kickoff.

[Predict Now]
```

States:

- Open
- Locked
- Live
- Full time
- Replay mode

### 2. Match picker

Used by bot creator.

Content:

- upcoming/replayable fixtures
- team names
- kickoff time
- status

Keep it short. Show max 5 matches.

### 3. Prediction entry screen

Purpose:

- submit prediction in under 10 seconds

UI:

```txt
Argentina vs France
What will the final score be?

Argentina   [-] 2 [+]
France      [-] 1 [+]

[Lock 2-1]
```

Rules shown below:

```txt
Predictions are hidden until kickoff.
Exact score wins. Closest score wins if nobody is exact.
```

No wallet, no odds, no crypto language.

### 4. Waiting room

Purpose:

- show user that they are in
- build anticipation

Content:

- match
- user's submitted score
- participant count
- lock status
- share/invite hint

Do not reveal other predictions before lock.

### 5. Live room

Purpose:

- main fan experience

Content:

- live score
- match clock/status
- current closest prediction
- leaderboard
- recent TxLINE-powered moments

Example:

```txt
Argentina 1 - 0 France
Live: 34'

Closest right now
1. Priya — 1-0 ✅ distance 0
2. Raghav — 2-1 distance 2
3. Aman — 0-0 distance 1

Moment
Goal changed the leader: Priya is now closest.
```

### 6. Result screen

Purpose:

- final clarity
- shareable bragging rights

Content:

- final score
- winner(s)
- all predictions
- distance from final score
- share card
- receipt link

Example:

```txt
Final: Argentina 2 - 1 France

Raghav called it exactly.

Raghav: 2-1 ✅
Priya: 1-0 — distance 2
Aman: 1-1 — distance 1
```

### 7. Receipt screen

Purpose:

- judge trust
- TxLINE visibility

Content:

- fixture ID
- TxLINE source
- final score
- score event count
- resolved timestamp
- optional proof payload link/collapsible JSON

Use plain English first, raw proof second.

## 12. Telegram Bot Spec

Recommended stack:

- `grammY` or `node-telegram-bot-api`
- TypeScript
- Hosted as webhook endpoint

Commands:

### `/start`

Used in private chat.

Response:

```txt
CalledIt lets your group predict World Cup scores and see who called it live.
Add me to a group and type /newpool.
```

### `/newpool`

Used in group chat.

Flow:

1. Bot checks user permission if needed.
2. Bot requests fixture list from backend.
3. Bot displays inline keyboard of matches.
4. User picks fixture.
5. Backend creates pool.
6. Bot posts pool card with Mini App button.

### `/leaderboard`

Returns current pool leaderboard.

MVP can support only latest active pool per group.

### `/result`

Returns final result if pool is resolved.

### Bot event messages

MVP messages:

- pool created
- predictions locked
- kickoff started
- goal changed leader
- full-time winner

Avoid spam. The bot is supporting UI, not the whole product.

## 13. Mini App Frontend Spec

Recommended stack:

- React + Vite or Next.js
- Telegram Mini Apps SDK
- Tailwind CSS
- Mobile-first layout

Routes:

```txt
/pool/:poolId
/pool/:poolId/predict
/pool/:poolId/live
/pool/:poolId/result
/pool/:poolId/receipt
```

Telegram identity:

- Read Telegram `initData` in Mini App.
- Send `initData` to backend.
- Backend verifies signature.
- Backend maps Telegram user to internal user.

No standalone login for MVP.

Core components:

- `ScoreStepper`
- `PoolStatusBadge`
- `LiveScoreHeader`
- `LeaderboardList`
- `PredictionCard`
- `MomentFeed`
- `ResultTable`
- `ReceiptPanel`
- `ShareCardButton`

Design principles:

- one-thumb mobile use
- no dense tables before result
- no wallet connect button
- no crypto words in consumer screens
- football-first language

## 14. Backend Spec

Recommended stack:

- Node.js + TypeScript
- Hono / Fastify / Next.js API routes
- Postgres preferred
- SQLite acceptable for hackathon
- Redis optional for live room state

Responsibilities:

- Verify Telegram Mini App init data.
- Manage users, groups, pools, predictions.
- Hold TxLINE credentials server-side.
- Fetch TxLINE fixtures.
- Subscribe to TxLINE live stream.
- Fetch TxLINE snapshots.
- Fetch TxLINE historical data for replay.
- Normalize score events.
- Recalculate leaderboard.
- Persist events and results.
- Trigger Telegram bot announcements.
- Expose judge-friendly receipt data.

Backend modules:

```txt
/src/telegram
/src/txline
/src/pools
/src/predictions
/src/leaderboard
/src/replay
/src/receipts
/src/db
```

## 15. Data Model

### `users`

```txt
id UUID primary key
telegram_user_id string unique
telegram_username string nullable
display_name string
photo_url string nullable
created_at timestamp
updated_at timestamp
```

### `telegram_groups`

```txt
id UUID primary key
telegram_chat_id string unique
title string nullable
created_at timestamp
updated_at timestamp
```

### `fixtures`

```txt
id UUID primary key
txline_fixture_id string unique
competition string
home_team string
away_team string
kickoff_at timestamp nullable
status string
raw_txline_json jsonb
created_at timestamp
updated_at timestamp
```

### `pools`

```txt
id UUID primary key
telegram_group_id UUID references telegram_groups(id)
fixture_id UUID references fixtures(id)
created_by_user_id UUID references users(id)
status enum('open','locked','live','resolved','cancelled')
mode enum('live','replay')
lock_at timestamp nullable
started_at timestamp nullable
resolved_at timestamp nullable
final_home_goals int nullable
final_away_goals int nullable
winning_distance int nullable
telegram_message_id string nullable
created_at timestamp
updated_at timestamp
```

### `predictions`

```txt
id UUID primary key
pool_id UUID references pools(id)
user_id UUID references users(id)
predicted_home_goals int
predicted_away_goals int
submitted_at timestamp
is_hidden boolean default true
final_distance int nullable
rank int nullable
created_at timestamp
updated_at timestamp
unique(pool_id, user_id)
```

### `score_events`

```txt
id UUID primary key
pool_id UUID references pools(id)
txline_fixture_id string
event_type string
match_status string nullable
home_goals int nullable
away_goals int nullable
match_clock string nullable
txline_timestamp timestamp nullable
raw_txline_json jsonb
created_at timestamp
```

### `leaderboard_snapshots`

```txt
id UUID primary key
pool_id UUID references pools(id)
score_event_id UUID references score_events(id) nullable
home_goals int
away_goals int
snapshot jsonb
created_at timestamp
```

### `receipts`

```txt
id UUID primary key
pool_id UUID references pools(id)
txline_fixture_id string
final_home_goals int
final_away_goals int
source enum('snapshot','stream','historical','stat_validation')
proof_json jsonb nullable
raw_txline_json jsonb nullable
created_at timestamp
```

## 16. API Spec

### Telegram webhook

```txt
POST /api/telegram/webhook
```

Receives Telegram bot updates.

### Mini App auth

```txt
POST /api/auth/telegram
```

Request:

```json
{
  "initData": "<telegram-init-data>"
}
```

Response:

```json
{
  "user": {
    "id": "uuid",
    "displayName": "Raghav"
  },
  "sessionToken": "jwt"
}
```

### Create pool

```txt
POST /api/pools
```

Request:

```json
{
  "telegramChatId": "-100123",
  "txlineFixtureId": "fixture_123",
  "mode": "replay"
}
```

Response:

```json
{
  "poolId": "uuid",
  "miniAppUrl": "https://calledit.app/pool/uuid"
}
```

### Get pool

```txt
GET /api/pools/:poolId
```

Returns:

- pool metadata
- fixture
- user prediction if submitted
- status
- participant count

### Submit prediction

```txt
POST /api/pools/:poolId/predictions
```

Request:

```json
{
  "predictedHomeGoals": 2,
  "predictedAwayGoals": 1
}
```

Rules:

- reject if pool locked
- reject if user already submitted unless edit window is open
- validate goals between 0 and 9 for MVP

### Get leaderboard

```txt
GET /api/pools/:poolId/leaderboard
```

Returns current leaderboard.

Before lock:

- show participant count only
- do not reveal predictions

After lock/live:

- show predictions and current distances

### Subscribe to live room

Option A:

```txt
GET /api/pools/:poolId/events
```

Server-Sent Events.

Option B:

```txt
WS /api/pools/:poolId/live
```

WebSocket.

MVP recommendation: SSE is simpler.

### Start replay

```txt
POST /api/pools/:poolId/replay/start
```

Request:

```json
{
  "speed": 30
}
```

Only available for demo/admin creator.

### Get result

```txt
GET /api/pools/:poolId/result
```

Returns final score, winners, all predictions, and distances.

### Get receipt

```txt
GET /api/pools/:poolId/receipt
```

Returns TxLINE-backed resolution data.

## 17. Leaderboard Algorithm

Input:

- pool predictions
- current score

Algorithm:

```ts
type Prediction = {
  userId: string;
  predictedHomeGoals: number;
  predictedAwayGoals: number;
  submittedAt: Date;
};

function distance(prediction: Prediction, homeGoals: number, awayGoals: number) {
  return (
    Math.abs(prediction.predictedHomeGoals - homeGoals) +
    Math.abs(prediction.predictedAwayGoals - awayGoals)
  );
}

function rankPredictions(predictions: Prediction[], homeGoals: number, awayGoals: number) {
  return predictions
    .map((prediction) => ({
      ...prediction,
      distance: distance(prediction, homeGoals, awayGoals),
      exact:
        prediction.predictedHomeGoals === homeGoals &&
        prediction.predictedAwayGoals === awayGoals,
    }))
    .sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.submittedAt.getTime() - b.submittedAt.getTime();
    });
}
```

MVP tie display:

- If multiple users have same distance, show same rank group.
- Do not overcomplicate tie-breaks in demo.

## 18. Moment Logic

The product needs small emotional moments.

Generate a moment when:

- match starts
- score changes
- current leader changes
- a user becomes exact
- exact prediction disappears after another goal
- half-time starts
- full-time starts

Example moment templates:

```txt
Goal changed the room: Priya is closest now.
Raghav has the exact score right now.
The 0-0 gang is officially dead.
Aman needs one France goal to call it exactly.
Nobody has the exact score anymore.
```

Keep tone playful, not gambling-coded.

Avoid:

```txt
cashout
odds
bet slip
parlay
stake
payout
wager
```

## 19. Replay Mode

Replay mode is mandatory for hackathon judging.

Why:

- Judges may review after live matches end.
- Demo video needs deterministic action.
- Track explicitly says demo video matters heavily.

Replay behavior:

1. Select completed fixture with historical TxLINE score data.
2. Create pool in replay mode.
3. Predictions remain open until creator starts replay.
4. Creator taps "Start replay".
5. App locks predictions.
6. Backend emits historical score events at accelerated speed.
7. Frontend and bot consume them exactly like live events.
8. Final result resolves from replayed final score and/or final snapshot.

Replay controls for demo admin:

- start
- pause
- reset
- speed: 10x / 30x / 60x
- jump to next goal
- jump to full time

Do not expose all controls to normal users.

## 20. Solana Scope

Core MVP should not require Solana.

Reason:

- Consumer track rewards fan accessibility.
- Wallets add friction.
- Real-money pools create gambling risk.
- The TxLINE data loop is already strong enough.

Allowed Solana stretch:

### Stretch A: Compressed NFT / badge

Mint a simple "Called It" badge for exact-score winners.

Only add if:

- core demo is already polished
- wallet flow is optional
- fan can ignore it

### Stretch B: Signed receipt hash

Write a hash of the final receipt to Solana devnet.

Only add if:

- it can be shown in 10 seconds
- it does not require user wallet setup

### Stretch C: Private escrow rooms

Not recommended for Consumer MVP.

If included later:

- clearly label as optional
- use free rooms by default
- avoid sportsbook language
- include legal caveat

Do not build in v1:

- Anchor escrow program
- session wallets
- prize pools
- USDC deposits
- payout claims
- odds-based settlement

## 21. Anti-Sportsbook Guardrails

The product must avoid becoming a sportsbook.

Use these terms:

- prediction
- score guess
- pool
- room
- leaderboard
- winner
- bragging rights
- called it
- receipt

Avoid these terms:

- bet
- wager
- stake
- parlay
- slip
- odds
- cashout
- payout
- book
- sportsbook
- market
- settlement

UX guardrails:

- no monetary entry amount in MVP
- no odds display in prediction flow
- no wallet connect in first-run flow
- no financial reward above the fold
- no betting-style green/red odds movement

## 22. Commercial Path

Do not overpitch monetization in the demo.

Plausible commercial paths:

1. Creator-hosted rooms for large football communities.
2. Sponsored World Cup prediction rooms.
3. White-label prediction pools for pubs, clubs, and fan pages.
4. Premium group features:
   - custom scoring
   - tournament leaderboard
   - branded share cards
   - exportable results
5. Optional paid private pools only where legal and compliant.

Hackathon pitch:

> Start with free group-chat prediction pools. Monetize through sponsored rooms and creator/community tools, not betting margins.

## 23. Recommended Build Plan

### Phase 1: Core backend + data

- Set up backend.
- Set up database schema.
- Add TxLINE auth.
- Fetch fixtures.
- Store fixture metadata.
- Fetch score snapshots.
- Implement replay event importer.

### Phase 2: Telegram bot

- Set up bot.
- Implement `/start`.
- Implement `/newpool`.
- Add fixture picker.
- Create pool from selected fixture.
- Post group message with Mini App button.

### Phase 3: Mini App prediction flow

- Verify Telegram init data.
- Create user session.
- Load pool.
- Submit score prediction.
- Show waiting room.
- Hide predictions before lock.

### Phase 4: Live/replay leaderboard

- Implement score event normalization.
- Implement ranking algorithm.
- Implement SSE/WebSocket broadcast.
- Build live room UI.
- Build moment feed.
- Trigger limited bot messages.

### Phase 5: Final result + receipt

- Resolve final score.
- Calculate winners.
- Build result screen.
- Build receipt screen.
- Post result back into Telegram.
- Add share card.

### Phase 6: Polish + demo

- Add seed/demo users.
- Add replay controls.
- Add loading/error states.
- Record 5-minute demo.
- Write technical docs.
- Prepare public repo.

## 24. Demo Script

### 0:00–0:25 — Problem

Show Telegram group.

Narration:

> Every World Cup group chat has people saying 2-1, 1-1, 3-2 before kickoff. The guesses get buried, copied, forgotten, or manually tracked in spreadsheets. CalledIt turns that into a live group-chat game.

### 0:25–1:05 — Create pool

Actions:

1. Type `/newpool`.
2. Bot shows World Cup fixtures from TxLINE.
3. Select a match.
4. Bot posts "Predict Now" card.

Narration:

> The match picker is powered by TxLINE fixture data.

### 1:05–1:45 — Submit predictions

Actions:

1. Tap "Predict Now".
2. Mini App opens.
3. Submit `2-1`.
4. Show two other test users submitting `1-1` and `3-2`.
5. Show predictions hidden until lock.

Narration:

> No wallet. No crypto explanation. Just pick the score and lock it.

### 1:45–2:45 — Live/replay match

Actions:

1. Start TxLINE historical replay.
2. Score starts at 0-0.
3. First goal event arrives.
4. Leaderboard changes.
5. Moment feed highlights leader change.

Narration:

> TxLINE score events power the live leaderboard. When the match changes, the room changes.

### 2:45–3:35 — Final whistle

Actions:

1. Replay reaches full time.
2. App resolves final score.
3. Winner appears.
4. Bot posts final result back into Telegram.

Narration:

> Nobody checks a spreadsheet. TxLINE gives the final score, CalledIt calculates who was exact or closest, and the group gets the result automatically.

### 3:35–4:25 — Receipt

Actions:

1. Open receipt.
2. Show fixture ID, final score, source, timestamps.
3. Expand raw TxLINE proof/data only briefly.

Narration:

> Fans do not need to understand proof data, but the result is traceable back to TxLINE.

### 4:25–5:00 — Close

Narration:

> CalledIt is a plug-and-play World Cup fan game for group chats. It uses TxLINE as the live data engine, and it is small enough to work as a real product during the tournament.

## 25. Testing Plan

### Product tests

- Create pool from Telegram group.
- Prevent duplicate active pool if MVP supports one active pool per group.
- Submit prediction before lock.
- Reject prediction after lock.
- Hide predictions before lock.
- Reveal predictions after lock.
- Calculate distance correctly.
- Rank users correctly.
- Handle tied winners.
- Resolve final result.
- Post result back to Telegram.

### TxLINE tests

- Fixture fetch works.
- Fixture IDs persist correctly.
- Score snapshot loads room state.
- Live/replay event normalizes correctly.
- Reconnect falls back to snapshot.
- Historical replay produces deterministic leaderboard.
- Final score receipt stores TxLINE metadata.

### Telegram tests

- `/start` works.
- `/newpool` works in group.
- Inline match picker works.
- Mini App opens from button.
- Telegram init data verification works.
- Bot posts lock/live/result messages.
- Bot does not spam group.

### UX tests

- First-time user can submit prediction in under 10 seconds.
- App works inside Telegram webview.
- App works on Android Telegram.
- App works on iOS Telegram.
- Score steppers are thumb-friendly.
- Result screen is understandable without explanation.

### Demo tests

- Replay starts reliably.
- Replay can be reset.
- Replay can jump to next goal.
- Demo can be run with fake/test Telegram users.
- Full demo works without live match availability.

## 26. Acceptance Criteria

The MVP is acceptable when:

- A user can create a World Cup pool in Telegram with `/newpool`.
- Group members can join through a Mini App button.
- A non-crypto fan can submit a prediction in under 10 seconds.
- Predictions remain hidden until lock.
- The room can run in live or replay mode using TxLINE data.
- Leaderboard updates when score changes.
- Final winner resolves from TxLINE-backed final score.
- Bot posts final result back into group.
- Receipt page shows TxLINE source clearly.
- Demo video can show the entire loop in under 5 minutes.
- No wallet is required for the core user flow.

## 27. Stretch Features

Only build after core loop is polished.

### Stretch 1: Tournament leaderboard

Track points across multiple World Cup matches:

- exact score: 3 points
- correct result only: 1 point
- wrong: 0 points

This is useful but not needed for initial demo.

### Stretch 2: Share card

Generate image:

```txt
Raghav called Argentina 2-1 France exactly.
Powered by TxLINE.
```

Good for demo polish.

### Stretch 3: Creator rooms

Allow creators to make public rooms and share a link.

### Stretch 4: TxLINE odds movement moment

Show non-betting commentary:

```txt
The market now sees France as less likely after the red card.
```

Use carefully. Do not make odds a prediction mechanic.

### Stretch 5: Solana badge

Optional badge for exact-score winners.

## 28. What Not To Build

Do not build these for the hackathon MVP:

- PvP parlays.
- Wallet-gated pools.
- Real-money deposits.
- Escrow settlement.
- On-chain pool state.
- Custodial session wallets.
- Sportsbook-style odds UI.
- AI pundit voice bot.
- Full fantasy squads.
- Player props.
- Push notification system.
- Native iOS/Android app.
- Admin dashboard.
- Public marketplace of pools.

These features either increase legal risk, reduce consumer clarity, or distract from the TxLINE-powered live fan experience.

## 29. Submission Checklist

- [ ] Working Telegram bot.
- [ ] Working Telegram Mini App URL.
- [ ] Public GitHub repo.
- [ ] Deployed backend.
- [ ] TxLINE fixture integration.
- [ ] TxLINE live/replay score integration.
- [ ] Result receipt page.
- [ ] Demo video under 5 minutes.
- [ ] Technical documentation.
- [ ] TxLINE feedback section.
- [ ] Clear note that core MVP is free-to-play and not gambling.

## 30. Technical Documentation Outline

Use this for the final submission README/docs:

```txt
# CalledIt Technical Overview

## What it does
A Telegram Mini App for World Cup score predictions. Groups predict exact scores, then TxLINE score data powers live leaderboard updates and final resolution.

## TxLINE endpoints used
- Fixtures endpoint for match picker
- Score snapshot endpoint for room state/reconnects
- Score stream endpoint for live updates
- Historical score endpoint for replay/demo
- Optional stat validation/proof endpoint for receipt

## Architecture
Telegram Bot -> Backend -> TxLINE
Telegram Mini App -> Backend -> DB
Backend -> Telegram Bot announcements

## Replay mode
Historical TxLINE score events are emitted through the same event pipeline as live events, allowing judges to test the full product after matches end.

## Data model
Users, groups, fixtures, pools, predictions, score events, leaderboard snapshots, receipts.

## What is not included
No betting, no escrow, no wallet requirement in the core MVP.

## Future work
Sponsored rooms, tournament leaderboards, creator rooms, optional Solana badges.
```

## 31. Naming Notes

Working names:

- CalledIt
- ScoreRoom
- FinalCall
- MatchCall
- CalledIt Live

Best current name: **CalledIt**

Why:

- instantly understandable
- football banter native
- no betting smell
- works for share cards
- short enough for Telegram bot

Possible bot username:

```txt
@calledit_wc_bot
@calleditlive_bot
@scorecall_bot
```

## 32. Final Recommendation

Build CalledIt as a Telegram Mini App, not a standalone dApp.

The win condition is not technical complexity. The win condition is a clean 5-minute demo where judges instantly understand:

1. fans already do this manually;
2. Telegram makes it plug-and-play;
3. TxLINE makes it live and trustworthy;
4. replay mode makes it demoable;
5. the product is fun without explaining crypto.

Do not add escrow until the free-to-play version feels complete.

The sharp MVP is:

> Create a World Cup score-prediction pool in Telegram, submit hidden exact-score guesses, watch the live closest-score leaderboard move with TxLINE data, and get an automatic final result receipt.

