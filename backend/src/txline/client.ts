import { config } from "../config.js";

export type NormalizedFixture = {
  txlineFixtureId: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  kickoffAt: string | null;
  status: string;
  raw: unknown;
};

export type NormalizedScoreEvent = {
  eventType: string;
  matchStatus: string | null;
  homeGoals: number;
  awayGoals: number;
  matchClock: string | null;
  txlineTimestamp: string | null;
  raw: unknown;
};

export class TxlineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxlineUnavailableError";
  }
}

const demoFixtures: NormalizedFixture[] = [
  {
    txlineFixtureId: "demo-wc-arg-fra-2022-final",
    competition: "World Cup",
    homeTeam: "Argentina",
    awayTeam: "France",
    kickoffAt: "2022-12-18T15:00:00.000Z",
    status: "replayable",
    raw: { source: "demo", fixture: "Argentina vs France" }
  },
  {
    txlineFixtureId: "demo-wc-eng-usa-2026-group",
    competition: "World Cup",
    homeTeam: "England",
    awayTeam: "USA",
    kickoffAt: new Date(Date.now() + 86_400_000).toISOString(),
    status: "scheduled",
    raw: { source: "demo", fixture: "England vs USA" }
  }
];

const demoReplay: NormalizedScoreEvent[] = [
  event("match_started", "live", 0, 0, "1'"),
  event("goal", "live", 1, 0, "23'"),
  event("half_time", "half_time", 1, 0, "45+2'"),
  event("goal", "live", 2, 0, "36'"),
  event("goal", "live", 2, 1, "80'"),
  event("goal", "live", 2, 2, "81'"),
  event("goal", "live", 3, 2, "108'"),
  event("goal", "live", 3, 3, "118'"),
  event("full_time", "full_time", 3, 3, "120+3'")
];

function event(
  eventType: string,
  matchStatus: string,
  homeGoals: number,
  awayGoals: number,
  matchClock: string
): NormalizedScoreEvent {
  return {
    eventType,
    matchStatus,
    homeGoals,
    awayGoals,
    matchClock,
    txlineTimestamp: new Date().toISOString(),
    raw: { source: "demo", eventType, matchStatus, homeGoals, awayGoals, matchClock }
  };
}

async function txlineFetch<T>(path: string): Promise<T | null> {
  const url = new URL(path.replace(/^\//, ""), config.TXLINE_BASE_URL);
  const headers: Record<string, string> = { accept: "application/json" };
  const authJwt = config.TXLINE_AUTH_JWT ?? config.TXLINE_GUEST_TOKEN;
  if (authJwt) headers.authorization = `Bearer ${authJwt}`;
  if (config.TXLINE_API_TOKEN) headers["x-api-token"] = config.TXLINE_API_TOKEN;

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function demoOrThrow<T>(value: T, reason: string): T {
  if (config.DEMO_MODE) return value;
  throw new TxlineUnavailableError(reason);
}

export class TxlineClient {
  async fixtures(kind: "upcoming" | "replayable"): Promise<NormalizedFixture[]> {
    const params = new URLSearchParams();
    if (config.TXLINE_COMPETITION_ID) params.set("competitionId", String(config.TXLINE_COMPETITION_ID));
    const query = params.toString();
    const data = await txlineFetch<unknown>(`/fixtures/snapshot${query ? `?${query}` : ""}`);
    const normalized = Array.isArray(data) ? data.map(normalizeFixture).filter(Boolean) : [];
    const fixtures =
      normalized.length > 0
        ? (normalized as NormalizedFixture[])
        : demoOrThrow(demoFixtures, `TxLINE ${kind} fixtures are unavailable`);
    return fixtures
      .filter((fixture) => fixture.competition.toLowerCase().includes("world cup"))
      .filter((fixture) => (kind === "upcoming" ? fixture.status !== "finished" : true))
      .slice(0, 5);
  }

  async snapshot(txlineFixtureId: string): Promise<NormalizedScoreEvent> {
    const data = await txlineFetch<unknown>(`/scores/snapshot/${encodeURIComponent(txlineFixtureId)}`);
    const events = Array.isArray(data) ? data.map(normalizeScoreEvent).filter(Boolean) : [];
    return (
      events.at(-1) ??
      normalizeScoreEvent(data) ??
      demoOrThrow(demoReplay.at(-1)!, "TxLINE score snapshot is unavailable")
    );
  }

  async historicalEvents(txlineFixtureId: string): Promise<NormalizedScoreEvent[]> {
    const data = await txlineFetch<unknown>(`/scores/historical/${encodeURIComponent(txlineFixtureId)}`);
    const events = Array.isArray(data) ? data.map(normalizeScoreEvent).filter(Boolean) : [];
    return events.length > 0
      ? (events as NormalizedScoreEvent[])
      : demoOrThrow(demoReplay, "TxLINE historical events are unavailable");
  }
}

function normalizeFixture(raw: unknown): NormalizedFixture | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = pickString(record, ["FixtureId", "id", "fixtureId", "fixture_id", "txlineFixtureId"]);
  const participant1 = pickString(record, ["Participant1", "participant1", "homeTeam", "home_team", "home", "teamHome"]);
  const participant2 = pickString(record, ["Participant2", "participant2", "awayTeam", "away_team", "away", "teamAway"]);
  if (!id || !participant1 || !participant2) return null;
  const participant1IsHome = pickBoolean(record, ["Participant1IsHome", "participant1IsHome"]);
  const home = participant1IsHome === false ? participant2 : participant1;
  const away = participant1IsHome === false ? participant1 : participant2;
  return {
    txlineFixtureId: id,
    competition: pickString(record, ["Competition", "competition", "league", "tournament"]) ?? "World Cup",
    homeTeam: home,
    awayTeam: away,
    kickoffAt: normalizeTimestamp(pickString(record, ["StartTime", "kickoffAt", "kickoff_at", "startTime", "start_time"])),
    status: pickString(record, ["status", "matchStatus", "state"]) ?? "scheduled",
    raw
  };
}

function normalizeScoreEvent(raw: unknown): NormalizedScoreEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const participant1Goals =
    pickScoreTotal(record, "scoreSoccer", "Participant1") ??
    pickScoreTotal(record, "score", "Participant1") ??
    pickNumber(record, ["participant1Goals", "Participant1Goals"]);
  const participant2Goals =
    pickScoreTotal(record, "scoreSoccer", "Participant2") ??
    pickScoreTotal(record, "score", "Participant2") ??
    pickNumber(record, ["participant2Goals", "Participant2Goals"]);
  const participant1IsHome = pickBoolean(record, ["participant1IsHome", "Participant1IsHome"]);
  const homeGoals =
    pickNumber(record, ["homeGoals", "home_goals", "homeScore", "home_score"]) ??
    (participant1IsHome === false ? participant2Goals : participant1Goals);
  const awayGoals =
    pickNumber(record, ["awayGoals", "away_goals", "awayScore", "away_score"]) ??
    (participant1IsHome === false ? participant1Goals : participant2Goals);
  if (homeGoals === null || awayGoals === null) return null;
  return {
    eventType: pickString(record, ["action", "Action", "eventType", "event_type", "type"]) ?? "snapshot",
    matchStatus:
      pickStatus(record, "statusSoccerId") ??
      pickStatus(record, "statusId") ??
      pickString(record, ["gameState", "matchStatus", "match_status", "status"]),
    homeGoals,
    awayGoals,
    matchClock: normalizeClock(record),
    txlineTimestamp: normalizeTimestamp(pickString(record, ["ts", "Ts", "timestamp", "txlineTimestamp", "txline_timestamp"])),
    raw
  };
}

function pickScoreTotal(record: Record<string, unknown>, scoreKey: string, participantKey: string) {
  const score = record[scoreKey];
  if (!score || typeof score !== "object") return null;
  const participant = (score as Record<string, unknown>)[participantKey];
  if (!participant || typeof participant !== "object") return null;
  const total = (participant as Record<string, unknown>).Total;
  if (!total || typeof total !== "object") return null;
  return pickNumber(total as Record<string, unknown>, ["Score", "score"]);
}

function pickStatus(record: Record<string, unknown>, key: string) {
  const status = record[key];
  if (!status || typeof status !== "object") return null;
  const entries = Object.entries(status as Record<string, unknown>);
  const active = entries.find(([, value]) => value === true || value === 1);
  return active?.[0] ?? null;
}

function normalizeClock(record: Record<string, unknown>) {
  const direct = pickString(record, ["matchClock", "match_clock", "minute"]);
  if (direct) return direct;
  const clock = record.clock;
  if (!clock || typeof clock !== "object") return null;
  const seconds = pickNumber(clock as Record<string, unknown>, ["seconds", "Seconds"]);
  return seconds === null ? null : `${Math.floor(seconds / 60)}'`;
}

function normalizeTimestamp(value: string | null) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return new Date(ms).toISOString();
  }
  return value;
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function pickBoolean(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
  }
  return null;
}

export const txlineClient = new TxlineClient();
