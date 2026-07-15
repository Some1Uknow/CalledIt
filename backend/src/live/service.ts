import { rankPredictions } from "../leaderboard/algorithm.js";
import { isMarketEnabled } from "../market/onchain.js";
import { claimUrl, settleMarketPoolFromFinalEvent } from "../market/service.js";
import { getMarketPool } from "../market/repository.js";
import {
  getPool,
  insertLeaderboardSnapshot,
  insertScoreEvent,
  latestScoreEvent,
  listActivePools,
  listPendingResultAnnouncements,
  listPredictions,
  lockDuePools,
  markResultAnnounced,
  setPoolStatus,
  setTelegramMessageId,
  telegramChatIdForPool,
  type PoolRecord
} from "../pools/repository.js";
import { resolvePool } from "../receipts/service.js";
import { editTelegramMessage, sendTelegramMessage } from "../telegram/client.js";
import {
  isTerminalScoreEvent,
  normalizeScoreEvent,
  txlineClient,
  type NormalizedScoreEvent
} from "../txline/client.js";

type SupervisorState = {
  running: boolean;
  connected: boolean;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastEventId: string | null;
  lastError: string | null;
};

const state: SupervisorState = {
  running: false,
  connected: false,
  lastConnectedAt: null,
  lastEventAt: null,
  lastEventId: null,
  lastError: null
};

let startPromise: Promise<void> | null = null;
const lastMessageState = new Map<string, string>();

export function liveSupervisorStatus() {
  return { ...state };
}

export function startLiveSupervisor() {
  if (startPromise) return startPromise;
  state.running = true;
  const lifecycleTimer = setInterval(() => void runLifecycleMaintenance(), 5_000);
  lifecycleTimer.unref();
  startPromise = superviseStream();
  return startPromise;
}

async function superviseStream() {
  let retryMs = 1_000;
  while (state.running) {
    const controller = new AbortController();
    try {
      const response = await txlineClient.openScoreStream(controller.signal, state.lastEventId);
      state.connected = true;
      state.lastConnectedAt = new Date().toISOString();
      state.lastError = null;
      retryMs = 1_000;
      for await (const message of readSseMessages(response.body!)) {
        if (!message.data) continue;
        const parsed = parseJson(message.data);
        const raw = parsed && typeof parsed === "object" && "data" in parsed ? (parsed as { data: unknown }).data : parsed;
        const event = normalizeScoreEvent(raw);
        if (!event) continue;
        if (!event.eventId && message.id) event.eventId = message.id;
        await processScoreEvent(event);
        state.lastEventAt = new Date().toISOString();
        if (message.id) state.lastEventId = message.id;
      }
      throw new Error("TxLINE score stream ended");
    } catch (error) {
      state.connected = false;
      state.lastError = error instanceof Error ? error.message : "Unknown TxLINE stream error";
      controller.abort();
      await delay(retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  }
}

export async function processScoreEvent(event: NormalizedScoreEvent) {
  if (!event.fixtureId) return;
  const pools = listActivePools().filter((pool) => pool.fixture.txlineFixtureId === event.fixtureId);
  for (const pool of pools) {
    const now = new Date().toISOString();
    if (pool.lockAt && pool.lockAt > now) continue;
    if (pool.status === "open") setPoolStatus(pool.id, "locked");
    const current = getPool(pool.id);
    if (!current || current.status === "resolved" || current.status === "cancelled") continue;
    if (current.status === "locked") setPoolStatus(current.id, "live", { startedAt: now });

    const fresh = getPool(current.id)!;
    const scoreEventId = insertScoreEvent(fresh, event);
    if (!scoreEventId) {
      if (isTerminalScoreEvent(event)) await resolveUnresolvedPool(fresh, event);
      continue;
    }
    const leaderboard = rankPredictions(listPredictions(fresh.id), event.homeGoals, event.awayGoals);
    insertLeaderboardSnapshot({
      poolId: fresh.id,
      scoreEventId,
      homeGoals: event.homeGoals,
      awayGoals: event.awayGoals,
      snapshot: leaderboard
    });
    try {
      await updateLiveMessage(fresh, event, leaderboard);
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : "Telegram live-message update failed";
    }

    if (isTerminalScoreEvent(event)) {
      await resolveUnresolvedPool(fresh, event);
    }
  }
}

async function resolveUnresolvedPool(pool: PoolRecord, event: NormalizedScoreEvent) {
  const unresolved = getPool(pool.id);
  if (!unresolved || unresolved.status === "resolved") return;
  const market = getMarketPool(unresolved.id);
  if (isMarketEnabled() && market) {
    try {
      const settlement = await settleMarketPoolFromFinalEvent(unresolved, event);
      if (!settlement) return;
      await resolvePool({
        pool: unresolved,
        finalHomeGoals: settlement.finalHomeGoals,
        finalAwayGoals: settlement.finalAwayGoals,
        source: "stat_validation",
        proofJson: settlement.proof,
        rawTxlineJson: event.raw
      });
    } catch (error) {
      state.lastError = error instanceof Error ? `Awaiting verified TxLINE settlement: ${error.message}` : "Awaiting verified TxLINE settlement";
    }
    return;
  }
  await resolvePool({
    pool: unresolved,
    finalHomeGoals: event.homeGoals,
    finalAwayGoals: event.awayGoals,
    source: "stream",
    rawTxlineJson: event.raw
  });
}

async function runLifecycleMaintenance() {
  try {
    const locked = lockDuePools();
    for (const pool of locked) {
      await updateLiveMessage(pool, latestScoreEvent(pool.id), []);
    }
    for (const pool of listActivePools().filter((item) => item.status === "live")) {
      const score = latestScoreEvent(pool.id);
      if (!score) continue;
      await updateLiveMessage(pool, score, rankPredictions(listPredictions(pool.id), score.homeGoals, score.awayGoals));
      if (isTerminalScoreEvent(score)) await resolveUnresolvedPool(pool, score);
    }
    for (const pool of listPendingResultAnnouncements()) {
      await announceFinalResult(pool);
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : "Lifecycle maintenance failed";
  }
}

async function updateLiveMessage(
  pool: PoolRecord,
  score: NormalizedScoreEvent | null,
  leaderboard: ReturnType<typeof rankPredictions>
) {
  const chatId = telegramChatIdForPool(pool.id);
  if (!chatId) return;
  const homeGoals = score?.homeGoals ?? 0;
  const awayGoals = score?.awayGoals ?? 0;
  const rows = leaderboard
    .slice(0, 10)
    .map((entry) => `${entry.rank}. ${entry.displayName} — ${entry.predictedHomeGoals}-${entry.predictedAwayGoals} (${entry.distance} away)`);
  const text =
    `${pool.fixture.homeTeam} ${homeGoals}-${awayGoals} ${pool.fixture.awayTeam}\n` +
    `${score?.matchClock ? `${score.matchClock} · ` : ""}${score?.matchStatus ?? pool.status}\n\n` +
    (rows.length > 0 ? rows.join("\n") : `${listPredictions(pool.id).length} predictions locked in.`);
  if (lastMessageState.get(pool.id) === text) return;

  if (pool.telegramMessageId) {
    await editTelegramMessage({ chatId, messageId: pool.telegramMessageId, text });
  } else {
    const sent = await sendTelegramMessage({ chatId, text });
    setTelegramMessageId(pool.id, String(sent.messageId));
  }
  lastMessageState.set(pool.id, text);
}

async function announceFinalResult(pool: PoolRecord) {
  if (pool.finalHomeGoals === null || pool.finalAwayGoals === null) return;
  const chatId = telegramChatIdForPool(pool.id);
  if (!chatId) return;
  const ranked = rankPredictions(listPredictions(pool.id), pool.finalHomeGoals, pool.finalAwayGoals);
  const market = getMarketPool(pool.id);
  const winningDistance = ranked[0]?.distance;
  const winners = market
    ? ranked
        .filter((entry) => entry.predictedHomeGoals === pool.finalHomeGoals && entry.predictedAwayGoals === pool.finalAwayGoals)
        .map((entry) => entry.displayName)
        .join(", ")
    : ranked.filter((entry) => entry.distance === winningDistance).map((entry) => entry.displayName).join(", ");
  await sendTelegramMessage({
    chatId,
    text: market
      ? `Verified final: ${pool.fixture.homeTeam} ${pool.finalHomeGoals}-${pool.finalAwayGoals} ${pool.fixture.awayTeam}\n\n${winners ? `${winners} called it exactly. Claim here: ${claimUrl(pool.id)}` : `No exact-score winner. Claim your on-chain refund here: ${claimUrl(pool.id)}`}`
      : `Final: ${pool.fixture.homeTeam} ${pool.finalHomeGoals}-${pool.finalAwayGoals} ${pool.fixture.awayTeam}\n\n${winners || "No winner"} called it closest.`
  });
  markResultAnnounced(pool.id);
}

type SseMessage = { id?: string; event?: string; data: string };

async function* readSseMessages(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.match(/\r?\n\r?\n/);
      while (separator?.index !== undefined) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const message = parseSseBlock(block);
        if (message) yield message;
        separator = buffer.match(/\r?\n\r?\n/);
      }
    }
    buffer += decoder.decode();
    const finalMessage = parseSseBlock(buffer);
    if (finalMessage) yield finalMessage;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): SseMessage | null {
  const message: SseMessage = { data: "" };
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    const value = separator === -1 ? "" : rawLine.slice(separator + 1).replace(/^ /, "");
    if (field === "data") message.data += `${value}\n`;
    if (field === "event") message.event = value;
    if (field === "id") message.id = value;
  }
  message.data = message.data.replace(/\n$/, "");
  return message.data || message.id || message.event ? message : null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
