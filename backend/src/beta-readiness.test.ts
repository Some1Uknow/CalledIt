import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import {
  activePoolForTelegramChat,
  createLivePool,
  getPool,
  getPoolByJoinCode,
  latestScoreEvent
} from "./pools/repository.js";
import { submitPrediction } from "./predictions/service.js";
import { getReceipt } from "./receipts/service.js";
import { createApp } from "./server.js";
import { processScoreEvent } from "./live/service.js";
import { upsertUser } from "./telegram/auth.js";
import { claimTelegramUpdate, completeTelegramUpdate, releaseTelegramUpdate } from "./telegram/updateStore.js";
import { isTerminalScoreEvent, normalizeScoreEvent, txlineClient } from "./txline/client.js";
import { upsertFixture } from "./txline/repository.js";

migrate();

beforeEach(() => {
  for (const table of [
    "telegram_updates",
    "receipts",
    "leaderboard_snapshots",
    "score_events",
    "market_intents",
    "market_pools",
    "predictions",
    "pools",
    "fixtures",
    "telegram_groups",
    "users"
  ]) {
    db.exec(`DELETE FROM ${table}`);
  }
});

afterEach(() => vi.unstubAllGlobals());

function fixture(id: string, kickoffAt: string) {
  return upsertFixture({
    txlineFixtureId: id,
    competition: "World Cup",
    homeTeam: "Home",
    awayTeam: "Away",
    participant1IsHome: true,
    kickoffAt,
    status: "scheduled",
    raw: { FixtureId: id }
  });
}

describe("bot-only beta safeguards", () => {
  it("stores only a join-code hash and prevents a second active pool", () => {
    const kickoff = new Date(Date.now() + 60_000).toISOString();
    const savedFixture = fixture("future-1", kickoff);
    const created = createLivePool({
      telegramChatId: "group-1",
      txlineFixtureDbId: savedFixture.id,
      createdByUserId: null,
      lockAt: kickoff
    });

    expect(created.joinCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(getPoolByJoinCode(created.joinCode)?.id).toBe(created.pool.id);
    const stored = db.prepare("SELECT join_code_hash FROM pools WHERE id = ?").get(created.pool.id) as {
      join_code_hash: string;
    };
    expect(stored.join_code_hash).not.toContain(created.joinCode);
    expect(activePoolForTelegramChat("group-1")?.id).toBe(created.pool.id);
    expect(() =>
      createLivePool({
        telegramChatId: "group-1",
        txlineFixtureDbId: savedFixture.id,
        createdByUserId: null,
        lockAt: kickoff
      })
    ).toThrow("already has an active");
  });

  it("atomically rejects predictions at or after kickoff and locks the pool", () => {
    const kickoff = new Date(Date.now() - 1_000).toISOString();
    const savedFixture = fixture("past-1", kickoff);
    const { pool } = createLivePool({
      telegramChatId: "group-2",
      txlineFixtureDbId: savedFixture.id,
      createdByUserId: null,
      lockAt: kickoff
    });
    const user = upsertUser({ telegramUserId: "user-1", displayName: "Player" });

    expect(() =>
      submitPrediction({ poolId: pool.id, userId: user.id, predictedHomeGoals: 1, predictedAwayGoals: 0 })
    ).toThrow("Predictions are locked");
    expect(getPool(pool.id)?.status).toBe("locked");
  });

  it("accepts one pre-kickoff prediction and returns a friendly duplicate error", () => {
    const kickoff = new Date(Date.now() + 60_000).toISOString();
    const savedFixture = fixture("future-2", kickoff);
    const { pool } = createLivePool({
      telegramChatId: "group-3",
      txlineFixtureDbId: savedFixture.id,
      createdByUserId: null,
      lockAt: kickoff
    });
    const user = upsertUser({ telegramUserId: "user-2", displayName: "Player" });
    submitPrediction({ poolId: pool.id, userId: user.id, predictedHomeGoals: 2, predictedAwayGoals: 1 });
    expect(() =>
      submitPrediction({ poolId: pool.id, userId: user.id, predictedHomeGoals: 1, predictedAwayGoals: 1 })
    ).toThrow("already locked a prediction");
  });

  it("deduplicates completed Telegram updates and permits retry after release", () => {
    expect(claimTelegramUpdate("100")).toBe(true);
    expect(claimTelegramUpdate("100")).toBe(false);
    completeTelegramUpdate("100");
    releaseTelegramUpdate("100");
    expect(claimTelegramUpdate("100")).toBe(false);

    expect(claimTelegramUpdate("101")).toBe(true);
    releaseTelegramUpdate("101");
    expect(claimTelegramUpdate("101")).toBe(true);
  });

  it("opens the private prediction picker only for members of the originating group", async () => {
    const kickoff = new Date(Date.now() + 60_000).toISOString();
    const savedFixture = fixture("future-member", kickoff);
    const { joinCode } = createLivePool({
      telegramChatId: "source-group",
      txlineFixtureDbId: savedFixture.id,
      createdByUserId: null,
      lockAt: kickoff
    });
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split("/").at(-1)!;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ method, body });
        const result = method === "getChatMember" ? { status: "member" } : { message_id: 99 };
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );

    const response = await createApp().request("/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret-32-bytes-long"
      },
      body: JSON.stringify({
        update_id: 200,
        message: {
          message_id: 1,
          text: `/start predict_${joinCode}`,
          chat: { id: "private-user", type: "private" },
          from: { id: "telegram-user", first_name: "Player" }
        }
      })
    });

    expect(response.status).toBe(200);
    expect(calls.map((call) => call.method)).toEqual(["getChatMember", "sendMessage"]);
    expect(calls[0].body).toMatchObject({ chat_id: "source-group", user_id: "telegram-user" });
    expect(calls[1].body.reply_markup).toBeTruthy();
  });

  it("explains the bot flow and all player commands with /help", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split("/").at(-1)!;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ method, body });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );

    const response = await createApp().request("/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret-32-bytes-long"
      },
      body: JSON.stringify({
        update_id: 203,
        message: {
          message_id: 2,
          text: "/help",
          chat: { id: "private-user", type: "private" },
          from: { id: "telegram-user", first_name: "Player" }
        }
      })
    });

    expect(response.status).toBe(200);
    const text = String(calls[0].body.text);
    expect(text).toContain("/newpool");
    expect(text).toContain("/leaderboard");
    expect(text).toContain("/result");
    expect(text).toContain("/lock");
    expect(text).toContain("No money, wallets, deposits, or payouts.");
  });

  it("increments a private score picker from its callback payload", async () => {
    const kickoff = new Date(Date.now() + 60_000).toISOString();
    const savedFixture = fixture("future-picker", kickoff);
    const { joinCode } = createLivePool({
      telegramChatId: "source-group",
      txlineFixtureDbId: savedFixture.id,
      createdByUserId: null,
      lockAt: kickoff
    });
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split("/").at(-1)!;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ method, body });
        const result = method === "getChatMember" ? { status: "member" } : true;
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );

    const response = await createApp().request("/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret-32-bytes-long"
      },
      body: JSON.stringify({
        update_id: 201,
        callback_query: {
          id: "callback-increment",
          data: `pred:${joinCode}:2:0`,
          from: { id: "telegram-user", first_name: "Player" },
          message: { message_id: 7, chat: { id: "private-user", type: "private" } }
        }
      })
    });

    expect(response.status).toBe(200);
    const edit = calls.find((call) => call.method === "editMessageText");
    expect(edit?.body.text).toContain("2 - 0");
    expect(JSON.stringify(edit?.body.reply_markup)).toContain(`lock:${joinCode}:2:0`);
  });

  it("completes replayed picker callbacks when Telegram says the edit is already applied", async () => {
    const kickoff = new Date(Date.now() + 60_000).toISOString();
    const savedFixture = fixture("future-picker-retry", kickoff);
    const { joinCode } = createLivePool({
      telegramChatId: "source-group",
      txlineFixtureDbId: savedFixture.id,
      createdByUserId: null,
      lockAt: kickoff
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split("/").at(-1)!;
        if (method === "answerCallbackQuery") {
          return new Response(
            JSON.stringify({
              ok: false,
              description: "Bad Request: query is too old and response timeout expired or query ID is invalid"
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        if (method === "getChatMember") {
          return new Response(JSON.stringify({ ok: true, result: { status: "member" } }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        if (method === "editMessageText") {
          return new Response(
            JSON.stringify({
              ok: false,
              description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same"
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        throw new Error(`Unexpected Telegram method: ${method}`);
      })
    );

    const response = await createApp().request("/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret-32-bytes-long"
      },
      body: JSON.stringify({
        update_id: 202,
        callback_query: {
          id: "callback-retry",
          data: `pred:${joinCode}:1:0`,
          from: { id: "telegram-user", first_name: "Player" },
          message: { message_id: 8, chat: { id: "private-user", type: "private" } }
        }
      })
    });

    expect(response.status).toBe(200);
    expect(db.prepare("SELECT processed_at FROM telegram_updates WHERE update_id = ?").get("202")).toMatchObject({
      processed_at: expect.any(String)
    });
  });

  it("exposes only health, readiness, and the authenticated Telegram webhook", async () => {
    const app = createApp();
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/ready")).status).toBe(200);
    expect((await app.request("/api/pools/example")).status).toBe(404);
    expect((await app.request("/api/auth/telegram", { method: "POST" })).status).toBe(404);
    expect((await app.request("/assets/solana-web3.iife.min.js")).status).toBe(404);
    expect((await app.request("/api/telegram/webhook", { method: "POST" })).status).toBe(401);
  });

  it("rejects oversized Telegram updates before parsing", async () => {
    const response = await createApp().request("/api/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret-32-bytes-long"
      },
      body: JSON.stringify({ update_id: 1, padding: "x".repeat(300_000) })
    });
    expect(response.status).toBe(413);
  });

  it("normalizes provider identity and terminal score status", () => {
    const event = normalizeScoreEvent({
      FixtureId: "fixture-1",
      Seq: 42,
      id: "event-42",
      statusSoccerId: { END: true },
      scoreSoccer: {
        Participant1: { Total: { Score: 2 } },
        Participant2: { Total: { Score: 1 } }
      }
    });
    expect(event).toMatchObject({ fixtureId: "fixture-1", seq: "42", eventId: "event-42", homeGoals: 2, awayGoals: 1 });
    expect(event && isTerminalScoreEvent(event)).toBe(true);
  });

  it("recognizes TxLINE's documented finalisation record", () => {
    const event = normalizeScoreEvent({
      FixtureId: "fixture-final",
      Seq: 43,
      action: "game_finalised",
      statusId: 100,
      period: 100,
      scoreSoccer: {
        Participant1: { Total: { Score: 2 } },
        Participant2: { Total: { Score: 1 } }
      }
    });
    expect(event?.matchStatus).toBe("100");
    expect(event && isTerminalScoreEvent(event)).toBe(true);
  });

  it("renews a rejected TxLINE JWT and resumes from the last SSE event", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, headers });
        if (calls.length === 1) return new Response(null, { status: 401 });
        if (url.endsWith("/auth/guest/start")) {
          return new Response(JSON.stringify({ token: "renewed-jwt" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(": connected\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      })
    );

    const response = await txlineClient.openScoreStream(new AbortController().signal, "event-41");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[0].headers.get("last-event-id")).toBe("event-41");
    expect(calls[1].url).toBe("https://txline-dev.txodds.com/auth/guest/start");
    expect(calls[2].headers.get("authorization")).toBe("Bearer renewed-jwt");
    expect(calls[2].headers.get("last-event-id")).toBe("event-41");
  });

  it("resolves a live pool once from an idempotent terminal TxLINE event", async () => {
    const kickoff = new Date(Date.now() + 60_000).toISOString();
    const savedFixture = fixture("live-final", kickoff);
    const { pool } = createLivePool({
      telegramChatId: "live-group",
      txlineFixtureDbId: savedFixture.id,
      createdByUserId: null,
      lockAt: kickoff
    });
    const user = upsertUser({ telegramUserId: "live-user", displayName: "Winner" });
    submitPrediction({ poolId: pool.id, userId: user.id, predictedHomeGoals: 2, predictedAwayGoals: 1 });
    db.prepare("UPDATE pools SET lock_at = ? WHERE id = ?").run(new Date(Date.now() - 1_000).toISOString(), pool.id);

    const telegramCalls = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", telegramCalls);
    const finalEvent = normalizeScoreEvent({
      FixtureId: "live-final",
      Seq: 99,
      id: "final-99",
      statusSoccerId: { END: true },
      scoreSoccer: {
        Participant1: { Total: { Score: 2 } },
        Participant2: { Total: { Score: 1 } }
      }
    });
    expect(finalEvent).not.toBeNull();

    await processScoreEvent(finalEvent!);
    await processScoreEvent(finalEvent!);

    expect(getPool(pool.id)).toMatchObject({ status: "resolved", finalHomeGoals: 2, finalAwayGoals: 1 });
    expect(latestScoreEvent(pool.id)).toMatchObject({ eventId: "final-99", seq: "99" });
    expect(getReceipt(pool.id)).toMatchObject({ finalHomeGoals: 2, finalAwayGoals: 1, chainStatus: "disabled" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM score_events WHERE pool_id = ?").get(pool.id)).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT final_distance, rank FROM predictions WHERE pool_id = ?").get(pool.id)).toMatchObject({
      final_distance: 0,
      rank: 1
    });
    expect(telegramCalls).toHaveBeenCalledTimes(1);
  });
});
