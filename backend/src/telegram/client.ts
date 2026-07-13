import { config } from "../config.js";

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

type TelegramEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description?: string
  ) {
    super(`Telegram ${method} failed (${status})${description ? `: ${description}` : ""}`);
    this.name = "TelegramApiError";
  }
}

async function telegramRequest<T>(method: string, body: unknown): Promise<T> {
  if (!config.TELEGRAM_BOT_TOKEN) throw new TelegramApiError(method, 503, "bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  const envelope = (await response.json().catch(() => ({ ok: false }))) as TelegramEnvelope<T>;
  if (!response.ok || !envelope.ok || envelope.result === undefined) {
    throw new TelegramApiError(method, response.status, envelope.description);
  }
  return envelope.result;
}

export async function sendTelegramMessage(input: {
  chatId: string | number;
  text: string;
  replyMarkup?: { inline_keyboard: TelegramInlineKeyboardButton[][] };
}) {
  const result = await telegramRequest<{ message_id: number }>("sendMessage", {
    chat_id: input.chatId,
    text: input.text,
    reply_markup: input.replyMarkup
  });
  return { messageId: result.message_id };
}

export async function answerTelegramCallback(callbackQueryId: string, text?: string) {
  try {
    await telegramRequest<boolean>("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  } catch (error) {
    // Telegram retries callbacks after a webhook 5xx. By then the callback may have
    // expired, but the underlying action can still be completed safely.
    if (isExpiredCallbackError(error)) return;
    throw error;
  }
}

export async function editTelegramMessage(input: {
  chatId: string | number;
  messageId: number | string;
  text: string;
  replyMarkup?: { inline_keyboard: TelegramInlineKeyboardButton[][] };
}) {
  try {
    await telegramRequest<unknown>("editMessageText", {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
      reply_markup: input.replyMarkup
    });
  } catch (error) {
    // A duplicated button tap or Telegram webhook retry can reach us after the
    // first request has already rendered the exact same picker state.
    if (isUnmodifiedMessageError(error)) return;
    throw error;
  }
}

export async function getTelegramChatMember(chatId: string | number, userId: string | number) {
  return telegramRequest<{ status?: string }>("getChatMember", { chat_id: chatId, user_id: userId });
}

function isUnmodifiedMessageError(error: unknown) {
  return (
    error instanceof TelegramApiError &&
    error.method === "editMessageText" &&
    error.status === 400 &&
    /message is not modified/i.test(error.description ?? "")
  );
}

function isExpiredCallbackError(error: unknown) {
  return (
    error instanceof TelegramApiError &&
    error.method === "answerCallbackQuery" &&
    error.status === 400 &&
    /(query is too old|response timeout expired|query id is invalid)/i.test(error.description ?? "")
  );
}
