import { randomUUID } from "node:crypto";
import { db, json, nowIso, parseJson } from "../db/client.js";
import type { Fixture } from "../db/types.js";
import type { NormalizedFixture } from "./client.js";

export function upsertFixture(input: NormalizedFixture): Fixture {
  const existing = db.prepare("SELECT id FROM fixtures WHERE txline_fixture_id = ?").get(input.txlineFixtureId) as
    | { id: string }
    | undefined;
  const id = existing?.id ?? randomUUID();
  const now = nowIso();

  db.prepare(
    `INSERT INTO fixtures (
      id, txline_fixture_id, competition, home_team, away_team, kickoff_at, status, raw_txline_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(txline_fixture_id) DO UPDATE SET
      competition = excluded.competition,
      home_team = excluded.home_team,
      away_team = excluded.away_team,
      kickoff_at = excluded.kickoff_at,
      status = excluded.status,
      raw_txline_json = excluded.raw_txline_json,
      updated_at = excluded.updated_at`
  ).run(
    id,
    input.txlineFixtureId,
    input.competition,
    input.homeTeam,
    input.awayTeam,
    input.kickoffAt,
    input.status,
    json(input.raw),
    now,
    now
  );

  return getFixtureByTxlineId(input.txlineFixtureId)!;
}

export function getFixtureByTxlineId(txlineFixtureId: string): Fixture | null {
  const row = db.prepare("SELECT * FROM fixtures WHERE txline_fixture_id = ?").get(txlineFixtureId);
  return row ? mapFixture(row as Record<string, unknown>) : null;
}

export function getFixture(id: string): Fixture | null {
  const row = db.prepare("SELECT * FROM fixtures WHERE id = ?").get(id);
  return row ? mapFixture(row as Record<string, unknown>) : null;
}

function mapFixture(row: Record<string, unknown>): Fixture {
  return {
    id: String(row.id),
    txlineFixtureId: String(row.txline_fixture_id),
    competition: String(row.competition),
    homeTeam: String(row.home_team),
    awayTeam: String(row.away_team),
    kickoffAt: row.kickoff_at ? String(row.kickoff_at) : null,
    status: String(row.status),
    rawTxlineJson: parseJson(String(row.raw_txline_json), {})
  };
}
