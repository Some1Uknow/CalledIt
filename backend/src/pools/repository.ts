import { randomUUID } from "node:crypto";
import { db, json, nowIso, parseJson } from "../db/client.js";
import type { Fixture, PoolMode, PoolStatus, Prediction } from "../db/types.js";
import type { NormalizedScoreEvent } from "../txline/client.js";
import { getFixture } from "../txline/repository.js";

export type PoolRecord = {
  id: string;
  telegramGroupId: string;
  fixtureId: string;
  createdByUserId: string | null;
  status: PoolStatus;
  mode: PoolMode;
  lockAt: string | null;
  startedAt: string | null;
  resolvedAt: string | null;
  finalHomeGoals: number | null;
  finalAwayGoals: number | null;
  winningDistance: number | null;
  telegramMessageId: string | null;
  fixture: Fixture;
};

export function upsertTelegramGroup(telegramChatId: string, title?: string | null) {
  const existing = db.prepare("SELECT id FROM telegram_groups WHERE telegram_chat_id = ?").get(telegramChatId) as
    | { id: string }
    | undefined;
  const id = existing?.id ?? randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO telegram_groups (id, telegram_chat_id, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(telegram_chat_id) DO UPDATE SET title = COALESCE(excluded.title, title), updated_at = excluded.updated_at`
  ).run(id, telegramChatId, title ?? null, now, now);
  return { id, telegramChatId, title: title ?? null };
}

export function createPool(input: {
  telegramChatId: string;
  txlineFixtureDbId: string;
  createdByUserId: string | null;
  mode: PoolMode;
  lockAt?: string | null;
}) {
  const group = upsertTelegramGroup(input.telegramChatId);
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO pools (
      id, telegram_group_id, fixture_id, created_by_user_id, status, mode, lock_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`
  ).run(id, group.id, input.txlineFixtureDbId, input.createdByUserId, input.mode, input.lockAt ?? null, now, now);
  return getPool(id)!;
}

export function getPool(id: string): PoolRecord | null {
  const row = db.prepare("SELECT * FROM pools WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  const fixture = getFixture(String(row.fixture_id));
  if (!fixture) return null;
  return {
    id: String(row.id),
    telegramGroupId: String(row.telegram_group_id),
    fixtureId: String(row.fixture_id),
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    status: row.status as PoolStatus,
    mode: row.mode as PoolMode,
    lockAt: row.lock_at ? String(row.lock_at) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    finalHomeGoals: row.final_home_goals === null ? null : Number(row.final_home_goals),
    finalAwayGoals: row.final_away_goals === null ? null : Number(row.final_away_goals),
    winningDistance: row.winning_distance === null ? null : Number(row.winning_distance),
    telegramMessageId: row.telegram_message_id ? String(row.telegram_message_id) : null,
    fixture
  };
}

export function latestPoolForTelegramChat(telegramChatId: string): PoolRecord | null {
  const row = db
    .prepare(
      `SELECT pools.id FROM pools
      JOIN telegram_groups ON telegram_groups.id = pools.telegram_group_id
      WHERE telegram_groups.telegram_chat_id = ?
      ORDER BY pools.created_at DESC
      LIMIT 1`
    )
    .get(telegramChatId) as { id: string } | undefined;
  return row ? getPool(row.id) : null;
}

export function telegramChatIdForPool(poolId: string): string | null {
  const row = db
    .prepare(
      `SELECT telegram_groups.telegram_chat_id
      FROM pools
      JOIN telegram_groups ON telegram_groups.id = pools.telegram_group_id
      WHERE pools.id = ?`
    )
    .get(poolId) as { telegram_chat_id: string } | undefined;
  return row?.telegram_chat_id ?? null;
}

export function setPoolStatus(id: string, status: PoolStatus, extra: Partial<PoolRecord> = {}) {
  db.prepare(
    `UPDATE pools SET
      status = ?,
      started_at = COALESCE(?, started_at),
      resolved_at = COALESCE(?, resolved_at),
      final_home_goals = COALESCE(?, final_home_goals),
      final_away_goals = COALESCE(?, final_away_goals),
      winning_distance = COALESCE(?, winning_distance),
      updated_at = ?
    WHERE id = ?`
  ).run(
    status,
    extra.startedAt ?? null,
    extra.resolvedAt ?? null,
    extra.finalHomeGoals ?? null,
    extra.finalAwayGoals ?? null,
    extra.winningDistance ?? null,
    nowIso(),
    id
  );
}

export function insertScoreEvent(pool: PoolRecord, input: NormalizedScoreEvent) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO score_events (
      id, pool_id, txline_fixture_id, event_type, match_status, home_goals, away_goals,
      match_clock, txline_timestamp, raw_txline_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    pool.id,
    pool.fixture.txlineFixtureId,
    input.eventType,
    input.matchStatus,
    input.homeGoals,
    input.awayGoals,
    input.matchClock,
    input.txlineTimestamp,
    json(input.raw),
    nowIso()
  );
  return id;
}

export function latestScoreEvent(poolId: string): NormalizedScoreEvent | null {
  const row = db
    .prepare("SELECT * FROM score_events WHERE pool_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(poolId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    eventType: String(row.event_type),
    matchStatus: row.match_status ? String(row.match_status) : null,
    homeGoals: Number(row.home_goals ?? 0),
    awayGoals: Number(row.away_goals ?? 0),
    matchClock: row.match_clock ? String(row.match_clock) : null,
    txlineTimestamp: row.txline_timestamp ? String(row.txline_timestamp) : null,
    raw: parseJson(String(row.raw_txline_json), {})
  };
}

export function insertLeaderboardSnapshot(input: {
  poolId: string;
  scoreEventId: string | null;
  homeGoals: number;
  awayGoals: number;
  snapshot: unknown;
}) {
  db.prepare(
    `INSERT INTO leaderboard_snapshots (id, pool_id, score_event_id, home_goals, away_goals, snapshot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), input.poolId, input.scoreEventId, input.homeGoals, input.awayGoals, json(input.snapshot), nowIso());
}

export function listPredictions(poolId: string): Prediction[] {
  const rows = db
    .prepare(
      `SELECT predictions.*, users.display_name
      FROM predictions
      JOIN users ON users.id = predictions.user_id
      WHERE predictions.pool_id = ?
      ORDER BY predictions.submitted_at ASC`
    )
    .all(poolId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    poolId: String(row.pool_id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    predictedHomeGoals: Number(row.predicted_home_goals),
    predictedAwayGoals: Number(row.predicted_away_goals),
    submittedAt: String(row.submitted_at),
    finalDistance: row.final_distance === null ? null : Number(row.final_distance),
    rank: row.rank === null ? null : Number(row.rank)
  }));
}
