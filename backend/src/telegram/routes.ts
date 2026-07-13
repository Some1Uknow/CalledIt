import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { config } from "../config.js";
import { rankPredictions } from "../leaderboard/algorithm.js";
import { createMarketPoolForFixture, createStakeIntentForPrediction, formatDevnetSol } from "../market/service.js";
import { getMarketPool } from "../market/repository.js";
import { submitPrediction } from "../predictions/service.js";
import {
  activePoolForTelegramChat,
  createLivePool,
  getPool,
  getPoolByJoinCode,
  latestPoolForTelegramChat,
  latestScoreEvent,
  listPredictions,
  setPoolStatus,
  setTelegramMessageId,
  telegramChatIdForPool
} from "../pools/repository.js";
import { txlineClient, TxlineUnavailableError } from "../txline/client.js";
import { upsertFixture } from "../txline/repository.js";
import { secureCompare } from "../utils/crypto.js";
import { upsertUser } from "./auth.js";
import {
  answerTelegramCallback,
  editTelegramMessage,
  getTelegramChatMember,
  sendTelegramMessage,
  type TelegramInlineKeyboardButton
} from "./client.js";
import { claimTelegramUpdate, completeTelegramUpdate, releaseTelegramUpdate } from "./updateStore.js";

const telegramUserSchema = z.object({
  id: z.union([z.number(), z.string()]),
  is_bot: z.boolean().optional(),
  first_name: z.string().max(128).optional(),
  last_name: z.string().max(128).optional(),
  username: z.string().max(64).optional()
});

const telegramUpdateSchema = z
  .object({
    update_id: z.union([z.number(), z.string()]),
    message: z
      .object({
        message_id: z.number().int(),
        text: z.string().max(4096).optional(),
        chat: z.object({
          id: z.union([z.number(), z.string()]),
          title: z.string().max(255).optional(),
          type: z.string().max(32).optional()
        }),
        from: telegramUserSchema.optional()
      })
      .optional(),
    callback_query: z
      .object({
        id: z.string().max(128),
        data: z.string().max(64).optional(),
        message: z
          .object({
            chat: z.object({ id: z.union([z.number(), z.string()]), type: z.string().max(32).optional() }),
            message_id: z.number().int(),
            text: z.string().max(4096).optional()
          })
          .optional(),
        from: telegramUserSchema
      })
      .optional()
  })
  .passthrough();

type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;
type TelegramUser = z.infer<typeof telegramUserSchema>;

const MAX_GOALS = 9;

function helpText() {
  if (config.MARKET_ENABLED) {
    return `CalledIt is a devnet-only exact-score pool. Stake is ${formatDevnetSol(config.MARKET_STAKE_LAMPORTS)} and has no real-world value.

How to play
1. An admin sends /newpool in the group.
2. Pick a match, then predict privately.
3. Choose an exact score and open the wallet link.
4. Approve the devnet SOL entry before kickoff.
5. TxLINE verifies the final score on-chain.
6. Exact winners claim the pot. No exact winner or cancelled pool means refunds.

Commands
/newpool — start a pool (admins)
/leaderboard — see confirmed entries
/result — see the verified result
/help — show this guide`;
  }
  return `CalledIt is a free football score game. No money, wallets, deposits, or payouts.

How to play
1. An admin sends /newpool in the group.
2. Pick a match.
3. Tap Predict privately.
4. Choose your final score and tap Lock.
5. Predictions lock at kickoff.
6. Follow the live leaderboard and final winner in the group.

Commands
/newpool — start a pool (admins)
/lock — lock predictions early (admins)
/leaderboard — see the table
/result — see the final winner
/help — show this guide`;
}

export function createTelegramRoutes() {
  const app = new Hono();

  app.use(
    "/webhook",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: "Telegram update is too large" }, 413)
    })
  );

  app.post("/webhook", async (c) => {
    const suppliedSecret = c.req.header("x-telegram-bot-api-secret-token");
    if (!config.TELEGRAM_WEBHOOK_SECRET) return c.json({ error: "Telegram webhook is not configured" }, 403);
    if (!suppliedSecret || !secureCompare(suppliedSecret, config.TELEGRAM_WEBHOOK_SECRET)) {
      return c.json({ error: "Invalid webhook secret" }, 401);
    }

    const update = telegramUpdateSchema.parse(await c.req.json());
    const updateId = String(update.update_id);
    if (!claimTelegramUpdate(updateId)) return c.json({ ok: true, duplicate: true });

    try {
      if (update.message?.text) await handleMessage(update);
      if (update.callback_query?.data) await handleCallback(update);
      completeTelegramUpdate(updateId);
      return c.json({ ok: true });
    } catch (error) {
      releaseTelegramUpdate(updateId);
      throw error;
    }
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
      if (!from) return;
      const joinCode = payload.slice("predict_".length);
      const pool = await requirePoolMember(joinCode, from, chatId);
      if (pool) await sendPredictionPicker(chatId, joinCode, 0, 0);
      return;
    }
    await sendTelegramMessage({
      chatId,
      text: "CalledIt lets your football group predict final scores and follow a live leaderboard. Add me to a group and type /newpool. Send /help for the quick guide."
    });
    return;
  }

  if (text.startsWith("/help")) {
    await sendTelegramMessage({ chatId, text: helpText() });
    return;
  }

  if (text.startsWith("/newpool")) {
    if (chatType === "private") {
      await sendTelegramMessage({ chatId, text: "Add me to a Telegram group and run /newpool there." });
      return;
    }
    if (!(await ensureGroupAdmin(chatId, from))) return;
    if (activePoolForTelegramChat(String(chatId))) {
      await sendTelegramMessage({ chatId, text: "This group already has an active CalledIt pool." });
      return;
    }
    try {
      const fixtures = (await txlineClient.fixtures("upcoming")).map(upsertFixture).slice(0, 5);
      if (fixtures.length === 0) {
        await sendTelegramMessage({ chatId, text: "No upcoming World Cup fixtures are available right now." });
        return;
      }
      await sendTelegramMessage({
        chatId,
        text: "Pick the next match for this CalledIt pool:",
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
    if (config.MARKET_ENABLED) {
      await sendTelegramMessage({ chatId, text: "On-chain market entries lock at the scheduled kickoff, so /lock is disabled for this pool." });
      return;
    }
    const pool = activePoolForTelegramChat(String(chatId));
    if (!pool) {
      await sendTelegramMessage({ chatId, text: "No active CalledIt pool exists in this chat." });
      return;
    }
    if (pool.status !== "open") {
      await sendTelegramMessage({ chatId, text: "Predictions are already locked." });
      return;
    }
    setPoolStatus(pool.id, "locked");
    await sendTelegramMessage({ chatId, text: "Predictions are locked. The leaderboard is now visible." });
    await sendLeaderboard(chatId);
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
    const pool = await requirePoolMember(parsed.joinCode, callback.from, chatId);
    if (!pool) return;
    await editTelegramMessage({
      chatId,
      messageId: callback.message.message_id,
      text: predictionText(parsed.homeGoals, parsed.awayGoals),
      replyMarkup: predictionKeyboard(parsed.joinCode, parsed.homeGoals, parsed.awayGoals)
    });
    return;
  }

  if (data.startsWith("lock:")) {
    if (!chatId || !callback.message) return;
    const parsed = parseScoreCallback(data);
    if (!parsed) return;
    const pool = await requirePoolMember(parsed.joinCode, callback.from, chatId);
    if (!pool) return;
    await handleLockPrediction(
      chatId,
      callback.message.message_id,
      callback.from,
      pool.id,
      parsed.homeGoals,
      parsed.awayGoals
    );
  }
}

async function handleNewPoolCallback(chatId: string | number, fixtureId: string, from: TelegramUser) {
  let createdPoolId: string | null = null;
  try {
    if (activePoolForTelegramChat(String(chatId))) {
      await sendTelegramMessage({ chatId, text: "This group already has an active CalledIt pool." });
      return;
    }
    const txlineFixture = (await txlineClient.fixtures("upcoming")).find((item) => item.txlineFixtureId === fixtureId);
    if (!txlineFixture?.kickoffAt) {
      await sendTelegramMessage({ chatId, text: "That fixture is no longer available. Run /newpool again." });
      return;
    }
    const fixture = upsertFixture(txlineFixture);
    const creator = upsertTelegramUser(from);
    const { pool, joinCode } = createLivePool({
      telegramChatId: String(chatId),
      txlineFixtureDbId: fixture.id,
      createdByUserId: creator.id,
      lockAt: txlineFixture.kickoffAt
    });
    createdPoolId = pool.id;
    const market = config.MARKET_ENABLED ? await createMarketPoolForFixture({ pool, fixture: txlineFixture }) : null;
    const predictUrl = `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=predict_${joinCode}`;
    const sent = await sendTelegramMessage({
      chatId,
      text:
        `${pool.fixture.homeTeam} vs ${pool.fixture.awayTeam}\n` +
        `Predictions lock at ${new Date(pool.lockAt!).toLocaleString("en-GB", { timeZone: "UTC" })} UTC.\n\n` +
        (config.MARKET_ENABLED
          ? `Exact-score entries are funded with ${formatDevnetSol(market!.stakeLamports)} before kickoff. TxLINE verifies the final score on-chain.`
          : "Predictions are submitted privately and stay hidden until kickoff."),
      replyMarkup: { inline_keyboard: [[{ text: "Predict privately", url: predictUrl }]] }
    });
    setTelegramMessageId(pool.id, String(sent.messageId));
  } catch (error) {
    if (createdPoolId) setPoolStatus(createdPoolId, "cancelled");
    await sendTelegramMessage({ chatId, text: txlineErrorText(error) });
  }
}

async function requirePoolMember(joinCode: string, user: TelegramUser, responseChatId: string | number) {
  const pool = getPoolByJoinCode(joinCode);
  if (!pool || pool.status !== "open" || !pool.joinCodeExpiresAt || pool.joinCodeExpiresAt <= new Date().toISOString()) {
    await sendTelegramMessage({ chatId: responseChatId, text: "This prediction link has expired or the pool is locked." });
    return null;
  }
  const groupChatId = telegramChatIdForPool(pool.id);
  if (!groupChatId) return null;
  const member = await getTelegramChatMember(groupChatId, user.id);
  if (!member || !["creator", "administrator", "member", "restricted"].includes(member.status ?? "")) {
    await sendTelegramMessage({ chatId: responseChatId, text: "Join the originating Telegram group before predicting." });
    return null;
  }
  return pool;
}

async function sendPredictionPicker(chatId: string | number, joinCode: string, homeGoals: number, awayGoals: number) {
  await sendTelegramMessage({
    chatId,
    text: predictionText(homeGoals, awayGoals),
    replyMarkup: predictionKeyboard(joinCode, homeGoals, awayGoals)
  });
}

function predictionText(homeGoals: number, awayGoals: number) {
  return `What will the final score be?\n\n${homeGoals} - ${awayGoals}\n\nUse the buttons below, then lock your prediction.`;
}

function predictionKeyboard(joinCode: string, homeGoals: number, awayGoals: number) {
  return {
    inline_keyboard: [
      [
        scoreButton("- Home", joinCode, Math.max(0, homeGoals - 1), awayGoals),
        scoreButton("+ Home", joinCode, Math.min(MAX_GOALS, homeGoals + 1), awayGoals)
      ],
      [
        scoreButton("- Away", joinCode, homeGoals, Math.max(0, awayGoals - 1)),
        scoreButton("+ Away", joinCode, homeGoals, Math.min(MAX_GOALS, awayGoals + 1))
      ],
      [{ text: `Lock ${homeGoals}-${awayGoals}`, callback_data: `lock:${joinCode}:${homeGoals}:${awayGoals}` }]
    ]
  };
}

function scoreButton(text: string, joinCode: string, homeGoals: number, awayGoals: number): TelegramInlineKeyboardButton {
  return { text, callback_data: `pred:${joinCode}:${homeGoals}:${awayGoals}` };
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
    if (config.MARKET_ENABLED) {
      const pool = getPool(poolId);
      if (!pool) throw new Error("Pool not found");
      const intent = createStakeIntentForPrediction({
        pool,
        userId: user.id,
        homeGoals,
        awayGoals
      });
      if (!intent) throw new Error("The on-chain pool is not ready");
      await editTelegramMessage({
        chatId,
        messageId,
        text: `Score selected: ${homeGoals}-${awayGoals}\n\nFund ${formatDevnetSol(intent.stakeLamports)} with your devnet wallet before kickoff. Your entry is only locked after the transaction confirms.`,
        replyMarkup: { inline_keyboard: [[{ text: `Stake ${formatDevnetSol(intent.stakeLamports)}`, url: intent.url }]] }
      });
      return;
    }
    submitPrediction({ poolId, userId: user.id, predictedHomeGoals: homeGoals, predictedAwayGoals: awayGoals });
    await editTelegramMessage({ chatId, messageId, text: `Prediction locked: ${homeGoals}-${awayGoals}` });
    const groupChatId = telegramChatIdForPool(poolId);
    if (groupChatId) {
      await sendTelegramMessage({
        chatId: groupChatId,
        text: `${user.displayName} joined. ${listPredictions(poolId).length} predictions locked in.`
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
    await sendTelegramMessage({ chatId, text: "No CalledIt pool exists in this chat yet." });
    return;
  }
  const predictions = listPredictions(pool.id);
  if (pool.status === "open") {
    await sendTelegramMessage({ chatId, text: `${predictions.length} predictions are locked in and hidden until kickoff.` });
    return;
  }
  const score = latestScoreEvent(pool.id);
  const homeGoals = score?.homeGoals ?? pool.finalHomeGoals ?? 0;
  const awayGoals = score?.awayGoals ?? pool.finalAwayGoals ?? 0;
  const rows = rankPredictions(predictions, homeGoals, awayGoals)
    .slice(0, 10)
    .map((entry) => `${entry.rank}. ${entry.displayName} — ${entry.predictedHomeGoals}-${entry.predictedAwayGoals} (${entry.distance} away)`);
  await sendTelegramMessage({
    chatId,
    text: `${pool.fixture.homeTeam} ${homeGoals}-${awayGoals} ${pool.fixture.awayTeam}\n\n${rows.join("\n") || "No predictions yet."}`
  });
}

async function sendResult(chatId: string | number) {
  const pool = latestPoolForTelegramChat(String(chatId));
  if (!pool || pool.status !== "resolved" || pool.finalHomeGoals === null || pool.finalAwayGoals === null) {
    await sendTelegramMessage({ chatId, text: "No final CalledIt result is ready yet." });
    return;
  }
  const ranked = rankPredictions(listPredictions(pool.id), pool.finalHomeGoals, pool.finalAwayGoals);
  const market = getMarketPool(pool.id);
  const winners = market
    ? ranked
        .filter((entry) => entry.predictedHomeGoals === pool.finalHomeGoals && entry.predictedAwayGoals === pool.finalAwayGoals)
        .map((entry) => entry.displayName)
        .join(", ")
    : ranked.filter((entry) => entry.distance === ranked[0]?.distance).map((entry) => entry.displayName).join(", ");
  await sendTelegramMessage({
    chatId,
    text: market
      ? `Verified final: ${pool.fixture.homeTeam} ${pool.finalHomeGoals}-${pool.finalAwayGoals} ${pool.fixture.awayTeam}\n\n${winners ? `${winners} called it exactly. Open the claim link in the group.` : "No exact-score winner. On-chain refunds are available."}`
      : `Final: ${pool.fixture.homeTeam} ${pool.finalHomeGoals}-${pool.finalAwayGoals} ${pool.fixture.awayTeam}\n\n${winners || "No winner"} called it closest.`
  });
}

function parseScoreCallback(data: string) {
  const [, joinCode, homeRaw, awayRaw] = data.split(":");
  const homeGoals = Number(homeRaw);
  const awayGoals = Number(awayRaw);
  if (!joinCode || !/^[A-Za-z0-9_-]{22}$/.test(joinCode)) return null;
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return null;
  if (homeGoals < 0 || homeGoals > MAX_GOALS || awayGoals < 0 || awayGoals > MAX_GOALS) return null;
  return { joinCode, homeGoals, awayGoals };
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
  if (!isAdmin) await sendTelegramMessage({ chatId, text: "Only group admins can do that." });
  return isAdmin;
}

function txlineErrorText(error: unknown) {
  if (error instanceof TxlineUnavailableError) return "TxLINE data is unavailable right now. Try again shortly.";
  if (error instanceof Error && error.message.includes("active CalledIt pool")) return error.message;
  return "Something went wrong. Try again shortly.";
}
