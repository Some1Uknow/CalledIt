import { Hono } from "hono";
import { config } from "../config.js";
import { rankPredictions } from "../leaderboard/algorithm.js";
import { submitPrediction } from "../predictions/service.js";
import { createPool, latestPoolForTelegramChat, listPredictions, setPoolStatus, telegramChatIdForPool } from "../pools/repository.js";
import { startReplay } from "../replay/service.js";
import { txlineClient, TxlineUnavailableError } from "../txline/client.js";
import { upsertFixture } from "../txline/repository.js";
import { upsertUser } from "./auth.js";
import {
  answerTelegramCallback,
  editTelegramMessage,
  getTelegramChatMember,
  sendTelegramMessage,
  type TelegramInlineKeyboardButton
} from "./client.js";

type TelegramUser = {
  id: number | string;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramUpdate = {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number | string; title?: string; type?: string };
    from?: TelegramUser;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number | string; type?: string }; message_id: number; text?: string };
    from?: TelegramUser;
  };
};

const MAX_GOALS = 9;

export function createTelegramRoutes() {
  const app = new Hono();

  app.post("/webhook", async (c) => {
    const secret = c.req.header("x-telegram-bot-api-secret-token");
    if (!config.TELEGRAM_WEBHOOK_SECRET) return c.json({ error: "Telegram webhook is not configured" }, 403);
    if (secret !== config.TELEGRAM_WEBHOOK_SECRET) return c.json({ error: "Invalid webhook secret" }, 401);

    const update = (await c.req.json()) as TelegramUpdate;
    if (update.message?.text) await handleMessage(update);
    if (update.callback_query?.data) await handleCallback(update);
    return c.json({ ok: true });
  });

  return app;
}

async function handleMessage(update: TelegramUpdate) {
  const message = update.message!;
  const text = message.text?.trim() ?? "";
  const chatId = message.chat.id;
  const chatType = message.chat.type ?? "private";
  const from = message.from;

  if (text.startsWith("/start")) {
    const payload = text.split(/\s+/, 2)[1];
    if (payload?.startsWith("predict_")) {
      await sendPredictionPicker(chatId, payload.slice("predict_".length), 0, 0);
      return;
    }
    await sendTelegramMessage({
      chatId,
      text:
        "CalledIt lets your group predict World Cup scores and see who called it live.\n\nAdd me to a group and type /newpool."
    });
    return;
  }

  if (text.startsWith("/newpool")) {
    if (chatType === "private") {
      await sendTelegramMessage({ chatId, text: "Add me to a Telegram group and run /newpool there." });
      return;
    }
    if (!(await ensureGroupAdmin(chatId, from))) return;

    try {
      const fixtures = (await txlineClient.fixtures("replayable")).map(upsertFixture).slice(0, 5);
      if (fixtures.length === 0) {
        await sendTelegramMessage({ chatId, text: "No World Cup fixtures are available right now." });
        return;
      }
      await sendTelegramMessage({
        chatId,
        text: "Pick a World Cup match for this CalledIt room:",
        replyMarkup: {
          inline_keyboard: fixtures.map((fixture) => [
            { text: `${fixture.homeTeam} vs ${fixture.awayTeam}`, callback_data: `newpool:${fixture.txlineFixtureId}` }
          ])
        }
      });
    } catch (error) {
      await sendTelegramMessage({ chatId, text: txlineErrorText(error) });
    }
    return;
  }

  if (text.startsWith("/leaderboard")) {
    await sendLeaderboard(chatId);
    return;
  }

  if (text.startsWith("/result")) {
    await sendResult(chatId);
    return;
  }

  if (text.startsWith("/lock")) {
    if (!(await ensureGroupAdmin(chatId, from))) return;
    const pool = latestPoolForTelegramChat(String(chatId));
    if (!pool) {
      await sendTelegramMessage({ chatId, text: "No CalledIt pool is active in this chat yet." });
      return;
    }
    if (pool.status !== "open") {
      await sendTelegramMessage({ chatId, text: "Predictions are already locked for this pool." });
      return;
    }
    setPoolStatus(pool.id, "locked");
    await sendTelegramMessage({ chatId, text: "Predictions are locked. Leaderboard is now visible." });
    await sendLeaderboard(chatId);
    return;
  }

  if (text.startsWith("/startreplay")) {
    if (!(await ensureGroupAdmin(chatId, from))) return;
    const pool = latestPoolForTelegramChat(String(chatId));
    if (!pool) {
      await sendTelegramMessage({ chatId, text: "No CalledIt pool is active in this chat yet." });
      return;
    }
    try {
      const result = await startReplay(pool.id);
      const winners = result.receipt.winners.length > 0 ? result.receipt.winners.join(", ") : "No winners";
      await sendTelegramMessage({
        chatId,
        text: `Final: ${pool.fixture.homeTeam} ${result.receipt.finalHomeGoals} - ${result.receipt.finalAwayGoals} ${pool.fixture.awayTeam}\n\n${winners} called it closest.`
      });
    } catch (error) {
      await sendTelegramMessage({ chatId, text: txlineErrorText(error) });
    }
  }
}

async function handleCallback(update: TelegramUpdate) {
  const callback = update.callback_query!;
  const data = callback.data ?? "";
  const chatId = callback.message?.chat.id;
  await answerTelegramCallback(callback.id);

  if (data.startsWith("newpool:")) {
    if (!chatId || !(await ensureGroupAdmin(chatId, callback.from))) return;
    await handleNewPoolCallback(chatId, data.slice("newpool:".length), callback.from);
    return;
  }

  if (data.startsWith("pred:")) {
    if (!chatId || !callback.message) return;
    const parsed = parseScoreCallback(data);
    if (!parsed) return;
    await editTelegramMessage({
      chatId,
      messageId: callback.message.message_id,
      text: predictionText(parsed.poolId, parsed.homeGoals, parsed.awayGoals),
      replyMarkup: predictionKeyboard(parsed.poolId, parsed.homeGoals, parsed.awayGoals)
    });
    return;
  }

  if (data.startsWith("lock:")) {
    if (!chatId || !callback.message || !callback.from) return;
    const parsed = parseScoreCallback(data);
    if (!parsed) return;
    await handleLockPrediction(chatId, callback.message.message_id, callback.from, parsed.poolId, parsed.homeGoals, parsed.awayGoals);
  }
}

async function handleNewPoolCallback(chatId: string | number, txlineFixtureId: string, from?: TelegramUser) {
  try {
    const txlineFixture = (await txlineClient.fixtures("replayable")).find((item) => item.txlineFixtureId === txlineFixtureId);
    if (!txlineFixture) {
      await sendTelegramMessage({ chatId, text: "That fixture is no longer available. Try /newpool again." });
      return;
    }
    const fixture = upsertFixture(txlineFixture);
    const creator = from ? upsertTelegramUser(from) : null;
    const pool = createPool({
      telegramChatId: String(chatId),
      txlineFixtureDbId: fixture.id,
      createdByUserId: creator?.id ?? null,
      mode: "replay",
      lockAt: fixture.kickoffAt
    });
    const predictUrl = `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=predict_${pool.id}`;
    await sendTelegramMessage({
      chatId,
      text:
        `${pool.fixture.homeTeam} vs ${pool.fixture.awayTeam}\n` +
        "Predict the final score before kickoff.\n\n" +
        "Predictions are submitted privately to the bot and stay hidden until /lock.",
      replyMarkup: { inline_keyboard: [[{ text: "Predict privately", url: predictUrl }]] }
    });
  } catch (error) {
    await sendTelegramMessage({ chatId, text: txlineErrorText(error) });
  }
}

async function sendPredictionPicker(chatId: string | number, poolId: string, homeGoals: number, awayGoals: number) {
  await sendTelegramMessage({
    chatId,
    text: predictionText(poolId, homeGoals, awayGoals),
    replyMarkup: predictionKeyboard(poolId, homeGoals, awayGoals)
  });
}

function predictionText(poolId: string, homeGoals: number, awayGoals: number) {
  return `What will the final score be?\n\n${homeGoals} - ${awayGoals}\n\nUse the buttons below, then lock your prediction.`;
}

function predictionKeyboard(poolId: string, homeGoals: number, awayGoals: number) {
  const homeDown = Math.max(0, homeGoals - 1);
  const homeUp = Math.min(MAX_GOALS, homeGoals + 1);
  const awayDown = Math.max(0, awayGoals - 1);
  const awayUp = Math.min(MAX_GOALS, awayGoals + 1);
  return {
    inline_keyboard: [
      [
        scoreButton("- Home", poolId, homeDown, awayGoals),
        scoreButton("+ Home", poolId, homeUp, awayGoals)
      ],
      [
        scoreButton("- Away", poolId, homeGoals, awayDown),
        scoreButton("+ Away", poolId, homeGoals, awayUp)
      ],
      [{ text: `Lock ${homeGoals}-${awayGoals}`, callback_data: `lock:${poolId}:${homeGoals}:${awayGoals}` }]
    ]
  };
}

function scoreButton(text: string, poolId: string, homeGoals: number, awayGoals: number): TelegramInlineKeyboardButton {
  return { text, callback_data: `pred:${poolId}:${homeGoals}:${awayGoals}` };
}

async function handleLockPrediction(
  chatId: string | number,
  messageId: number,
  from: TelegramUser,
  poolId: string,
  homeGoals: number,
  awayGoals: number
) {
  const user = upsertTelegramUser(from);
  try {
    submitPrediction({ poolId, userId: user.id, predictedHomeGoals: homeGoals, predictedAwayGoals: awayGoals });
    await editTelegramMessage({
      chatId,
      messageId,
      text: `Prediction locked: ${homeGoals}-${awayGoals}\n\nPredictions stay hidden in the group until lock.`
    });
    const groupChatId = telegramChatIdForPool(poolId);
    if (groupChatId) {
      const pool = latestPoolForTelegramChat(groupChatId);
      await sendTelegramMessage({
        chatId: groupChatId,
        text: `${user.displayName} joined. ${pool ? listPredictions(pool.id).length : ""} predictions locked in.`
      });
    }
  } catch (error) {
    await editTelegramMessage({
      chatId,
      messageId,
      text: error instanceof Error ? error.message : "Could not lock prediction."
    });
  }
}

async function sendLeaderboard(chatId: string | number) {
  const pool = latestPoolForTelegramChat(String(chatId));
  if (!pool) {
    await sendTelegramMessage({ chatId, text: "No CalledIt pool is active in this chat yet." });
    return;
  }
  const predictions = listPredictions(pool.id);
  if (pool.status === "open") {
    await sendTelegramMessage({ chatId, text: `${predictions.length} friends have joined. Predictions are hidden until /lock.` });
    return;
  }
  const ranked = rankPredictions(predictions, pool.finalHomeGoals ?? 0, pool.finalAwayGoals ?? 0).slice(0, 10);
  const rows = ranked.map(
    (entry) => `${entry.rank}. ${entry.displayName} - ${entry.predictedHomeGoals}-${entry.predictedAwayGoals}, distance ${entry.distance}`
  );
  await sendTelegramMessage({
    chatId,
    text: rows.length > 0 ? rows.join("\n") : "No predictions have been submitted yet."
  });
}

async function sendResult(chatId: string | number) {
  const pool = latestPoolForTelegramChat(String(chatId));
  if (!pool || pool.status !== "resolved" || pool.finalHomeGoals === null || pool.finalAwayGoals === null) {
    await sendTelegramMessage({ chatId, text: "No final CalledIt result is ready yet." });
    return;
  }
  const ranked = rankPredictions(listPredictions(pool.id), pool.finalHomeGoals, pool.finalAwayGoals);
  const winners = ranked.filter((entry) => entry.distance === ranked[0]?.distance).map((entry) => entry.displayName).join(", ");
  await sendTelegramMessage({
    chatId,
    text: `Final: ${pool.fixture.homeTeam} ${pool.finalHomeGoals} - ${pool.finalAwayGoals} ${pool.fixture.awayTeam}\n\n${winners} called it closest.`
  });
}

function parseScoreCallback(data: string) {
  const [, poolId, homeRaw, awayRaw] = data.split(":");
  const homeGoals = Number(homeRaw);
  const awayGoals = Number(awayRaw);
  if (!poolId || !Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return null;
  if (homeGoals < 0 || homeGoals > MAX_GOALS || awayGoals < 0 || awayGoals > MAX_GOALS) return null;
  return { poolId, homeGoals, awayGoals };
}

function upsertTelegramUser(user: TelegramUser) {
  return upsertUser({
    telegramUserId: String(user.id),
    telegramUsername: user.username ?? null,
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || `User ${user.id}`
  });
}

async function ensureGroupAdmin(chatId: string | number, user?: TelegramUser) {
  if (!user) return false;
  const member = await getTelegramChatMember(chatId, user.id);
  const isAdmin = member?.status === "creator" || member?.status === "administrator";
  if (!isAdmin) {
    await sendTelegramMessage({ chatId, text: "Only group admins can do that." });
  }
  return isAdmin;
}

function txlineErrorText(error: unknown) {
  if (error instanceof TxlineUnavailableError) return "TxLINE data is not available for this action right now.";
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
