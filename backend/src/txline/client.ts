import { config } from "../config.js";

export type NormalizedFixture = {
  txlineFixtureId: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  participant1IsHome: boolean;
  kickoffAt: string | null;
  status: string;
  raw: unknown;
};

export type NormalizedScoreEvent = {
  eventId: string | null;
  seq: string | null;
  fixtureId: string | null;
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
    participant1IsHome: true,
    kickoffAt: "2022-12-18T15:00:00.000Z",
    status: "replayable",
    raw: { source: "demo", fixture: "Argentina vs France" }
  },
  {
    txlineFixtureId: "demo-wc-eng-usa-2026-group",
    competition: "World Cup",
    homeTeam: "England",
    awayTeam: "USA",
    participant1IsHome: true,
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

let runtimeAuthJwt = config.TXLINE_AUTH_JWT ?? config.TXLINE_GUEST_TOKEN;

function event(
  eventType: string,
  matchStatus: string,
  homeGoals: number,
  awayGoals: number,
  matchClock: string
): NormalizedScoreEvent {
  return {
    eventId: null,
    seq: null,
    fixtureId: null,
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
  try {
    let response = await fetch(url, {
      headers: txlineHeaders("application/json"),
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 401 && (await renewRuntimeJwt())) {
      response = await fetch(url, {
        headers: txlineHeaders("application/json"),
        signal: AbortSignal.timeout(10_000)
      });
    }
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
    const now = Date.now();
    return fixtures
      .filter((fixture) => fixture.competition.toLowerCase().includes("world cup"))
      .filter((fixture) => {
        const kickoff = fixture.kickoffAt ? Date.parse(fixture.kickoffAt) : Number.NaN;
        if (!Number.isFinite(kickoff)) return false;
        if (kind === "upcoming") return fixture.status === "scheduled" && kickoff > now;
        return kickoff <= now - 6 * 60 * 60 * 1000 && kickoff >= now - 14 * 24 * 60 * 60 * 1000;
      })
      .sort((a, b) => Date.parse(a.kickoffAt!) - Date.parse(b.kickoffAt!))
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

  async scoreStatValidation(txlineFixtureId: string, seq: string): Promise<unknown> {
    if (!/^\d+$/.test(txlineFixtureId) || !/^\d+$/.test(seq) || Number(seq) < 1) {
      throw new TxlineUnavailableError("TxLINE validation requires a numeric fixture ID and a real score sequence");
    }
    const query = new URLSearchParams({ fixtureId: txlineFixtureId, seq, statKeys: "1,2" });
    const data = await txlineFetch<unknown>(`/scores/stat-validation?${query}`);
    if (!data) throw new TxlineUnavailableError("TxLINE score validation is unavailable");
    return data;
  }

  async openScoreStream(signal: AbortSignal, lastEventId?: string | null) {
    const url = new URL("scores/stream", config.TXLINE_BASE_URL);
    let response = await fetch(url, { headers: txlineHeaders("text/event-stream", lastEventId), signal });
    if (response.status === 401 && (await renewRuntimeJwt(signal))) {
      response = await fetch(url, { headers: txlineHeaders("text/event-stream", lastEventId), signal });
    }
    if (!response.ok || !response.body) throw new TxlineUnavailableError(`TxLINE score stream failed (${response.status})`);
    return response;
  }
}

function txlineHeaders(accept: string, lastEventId?: string | null) {
  const headers: Record<string, string> = { accept };
  if (accept === "text/event-stream") headers["cache-control"] = "no-cache";
  if (runtimeAuthJwt) headers.authorization = `Bearer ${runtimeAuthJwt}`;
  if (config.TXLINE_API_TOKEN) headers["x-api-token"] = config.TXLINE_API_TOKEN;
  if (lastEventId) headers["last-event-id"] = lastEventId;
  return headers;
}

async function renewRuntimeJwt(parentSignal?: AbortSignal) {
  try {
    const timeout = AbortSignal.timeout(10_000);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    const response = await fetch(new URL("/auth/guest/start", config.TXLINE_BASE_URL), {
      method: "POST",
      headers: { accept: "application/json" },
      signal
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== "string" || body.token.length === 0) return false;
    runtimeAuthJwt = body.token;
    return true;
  } catch {
    return false;
  }
}

function normalizeFixture(raw: unknown): NormalizedFixture | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = pickString(record, ["FixtureId", "id", "fixtureId", "fixture_id", "txlineFixtureId"]);
  const participant1 = pickString(record, ["Participant1", "participant1", "homeTeam", "home_team", "home", "teamHome"]);
  const participant2 = pickString(record, ["Participant2", "participant2", "awayTeam", "away_team", "away", "teamAway"]);
  const competition = pickString(record, ["Competition", "competition", "league", "tournament"]);
  if (!id || !participant1 || !participant2 || !competition) return null;
  const participant1IsHome = pickBoolean(record, ["Participant1IsHome", "participant1IsHome"]);
  const home = participant1IsHome === false ? participant2 : participant1;
  const away = participant1IsHome === false ? participant1 : participant2;
  return {
    txlineFixtureId: id,
    competition,
    homeTeam: home,
    awayTeam: away,
    participant1IsHome: participant1IsHome !== false,
    kickoffAt: normalizeTimestamp(pickString(record, ["StartTime", "kickoffAt", "kickoff_at", "startTime", "start_time"])),
    status: normalizeFixtureStatus(record),
    raw
  };
}

export function normalizeScoreEvent(raw: unknown): NormalizedScoreEvent | null {
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
    eventId: pickString(record, ["id", "Id", "eventId", "event_id"]),
    seq: pickString(record, ["seq", "Seq", "sequence"]),
    fixtureId: pickString(record, ["fixtureId", "FixtureId", "fixture_id"]),
    eventType: pickString(record, ["action", "Action", "eventType", "event_type", "type"]) ?? "snapshot",
    matchStatus:
      pickStatus(record, "statusSoccerId") ??
      pickStatus(record, "statusId") ??
      pickString(record, ["gameState", "matchStatus", "match_status", "status", "statusId", "StatusId"]),
    homeGoals,
    awayGoals,
    matchClock: normalizeClock(record),
    txlineTimestamp: normalizeTimestamp(pickString(record, ["ts", "Ts", "timestamp", "txlineTimestamp", "txline_timestamp"])),
    raw
  };
}

function normalizeFixtureStatus(record: Record<string, unknown>) {
  const raw = record.GameState ?? record.gameState ?? record.status ?? record.matchStatus ?? record.state;
  if (raw === 1 || raw === "1") return "scheduled";
  if (raw === 6 || raw === "6") return "cancelled";
  const status = typeof raw === "string" ? raw.toLowerCase() : "scheduled";
  if (["scheduled", "not_started", "ns"].includes(status)) return "scheduled";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["finished", "full_time", "end"].includes(status)) return "finished";
  return status;
}

export function isTerminalScoreEvent(event: NormalizedScoreEvent) {
  const status = event.matchStatus?.toUpperCase() ?? "";
  return ["END", "F2", "FET", "FPE", "WET", "WPE", "FT", "FULL_TIME", "FINISHED", "100"].includes(status) || isFinalisedScoreEvent(event);
}

/** TxLINE documents this exact final record shape for settlement proofs. */
export function isFinalisedScoreEvent(event: NormalizedScoreEvent) {
  if (event.eventType.toLowerCase() !== "game_finalised") return false;
  const raw = event.raw && typeof event.raw === "object" ? (event.raw as Record<string, unknown>) : {};
  const statusId = pickNumber(raw, ["statusId", "StatusId"]);
  const period = pickNumber(raw, ["period", "Period"]);
  return statusId === 100 && period === 100;
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
