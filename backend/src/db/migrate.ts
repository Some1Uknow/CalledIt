import { db } from "./client.js";

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT UNIQUE NOT NULL,
  telegram_username TEXT,
  display_name TEXT NOT NULL,
  photo_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_groups (
  id TEXT PRIMARY KEY,
  telegram_chat_id TEXT UNIQUE NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fixtures (
  id TEXT PRIMARY KEY,
  txline_fixture_id TEXT UNIQUE NOT NULL,
  competition TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff_at TEXT,
  status TEXT NOT NULL,
  raw_txline_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pools (
  id TEXT PRIMARY KEY,
  telegram_group_id TEXT NOT NULL REFERENCES telegram_groups(id),
  fixture_id TEXT NOT NULL REFERENCES fixtures(id),
  created_by_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('open','locked','live','resolved','cancelled')),
  mode TEXT NOT NULL CHECK (mode IN ('live','replay')),
  lock_at TEXT,
  started_at TEXT,
  resolved_at TEXT,
  final_home_goals INTEGER,
  final_away_goals INTEGER,
  winning_distance INTEGER,
  telegram_message_id TEXT,
  join_code_hash TEXT,
  join_code_expires_at TEXT,
  result_announced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  predicted_home_goals INTEGER NOT NULL,
  predicted_away_goals INTEGER NOT NULL,
  submitted_at TEXT NOT NULL,
  is_hidden INTEGER NOT NULL DEFAULT 1,
  final_distance INTEGER,
  rank INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(pool_id, user_id)
);

CREATE TABLE IF NOT EXISTS score_events (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  txline_fixture_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  match_status TEXT,
  home_goals INTEGER,
  away_goals INTEGER,
  match_clock TEXT,
  txline_timestamp TEXT,
  txline_event_id TEXT,
  txline_seq TEXT,
  raw_txline_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  score_event_id TEXT REFERENCES score_events(id),
  home_goals INTEGER NOT NULL,
  away_goals INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  pool_id TEXT UNIQUE NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  txline_fixture_id TEXT NOT NULL,
  final_home_goals INTEGER NOT NULL,
  final_away_goals INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('snapshot','stream','historical','stat_validation')),
  proof_json TEXT,
  raw_txline_json TEXT,
  receipt_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_pools (
  pool_id TEXT PRIMARY KEY REFERENCES pools(id) ON DELETE CASCADE,
  market_pool_address TEXT UNIQUE NOT NULL,
  vault_address TEXT NOT NULL,
  pool_seed_hex TEXT NOT NULL,
  txline_fixture_id INTEGER NOT NULL,
  participant1_is_home INTEGER NOT NULL,
  stake_lamports INTEGER NOT NULL,
  creation_signature TEXT NOT NULL,
  proof_status TEXT NOT NULL CHECK (proof_status IN ('pending','verified','failed','unavailable')),
  proof_json TEXT,
  settlement_signature TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_intents (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  home_goals INTEGER NOT NULL,
  away_goals INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','expired')),
  wallet_address TEXT,
  entry_address TEXT,
  signature TEXT,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pools_group ON pools(telegram_group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_predictions_pool ON predictions(pool_id);
CREATE INDEX IF NOT EXISTS idx_score_events_pool_created ON score_events(pool_id, created_at);
CREATE INDEX IF NOT EXISTS idx_market_intents_pool_user ON market_intents(pool_id, user_id, status);
`;

export function migrate() {
  db.exec(schema);
  addColumnIfMissing("pools", "join_code_hash", "TEXT");
  addColumnIfMissing("pools", "join_code_expires_at", "TEXT");
  addColumnIfMissing("pools", "result_announced_at", "TEXT");
  addColumnIfMissing("score_events", "txline_event_id", "TEXT");
  addColumnIfMissing("score_events", "txline_seq", "TEXT");
  addColumnIfMissing("predictions", "wallet_address", "TEXT");
  addColumnIfMissing("predictions", "market_entry_address", "TEXT");
  addColumnIfMissing("predictions", "market_entry_signature", "TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pools_join_code_hash
      ON pools(join_code_hash) WHERE join_code_hash IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_score_events_provider_event
      ON score_events(pool_id, txline_event_id) WHERE txline_event_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_score_events_provider_seq
      ON score_events(pool_id, txline_seq) WHERE txline_seq IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_predictions_market_wallet
      ON predictions(pool_id, wallet_address) WHERE wallet_address IS NOT NULL;
  `);
}

function addColumnIfMissing(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
