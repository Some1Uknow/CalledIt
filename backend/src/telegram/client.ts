import { config } from "../config.js";

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export async function sendTelegramMessage(input: {
  chatId: string | number;
  text: string;
  replyMarkup?: { inline_keyboard: TelegramInlineKeyboardButton[][] };
}) {
  if (!config.TELEGRAM_BOT_TOKEN) {
    return { skipped: true, reason: "TELEGRAM_BOT_TOKEN is not configured" };
  }

  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      text: input.text,
      reply_markup: input.replyMarkup
    })
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      description: await response.text()
    };
  }
  return response.json();
}

export async function answerTelegramCallback(callbackQueryId: string, text?: string) {
  if (!config.TELEGRAM_BOT_TOKEN) return { skipped: true, reason: "TELEGRAM_BOT_TOKEN is not configured" };

  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
  return response.ok ? response.json() : { ok: false, status: response.status, description: await response.text() };
}

export async function editTelegramMessage(input: {
  chatId: string | number;
  messageId: number;
  text: string;
  replyMarkup?: { inline_keyboard: TelegramInlineKeyboardButton[][] };
}) {
  if (!config.TELEGRAM_BOT_TOKEN) return { skipped: true, reason: "TELEGRAM_BOT_TOKEN is not configured" };

  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
      reply_markup: input.replyMarkup
    })
  });
  return response.ok ? response.json() : { ok: false, status: response.status, description: await response.text() };
}

export async function getTelegramChatMember(chatId: string | number, userId: string | number) {
  if (!config.TELEGRAM_BOT_TOKEN) return null;

  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getChatMember`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, user_id: userId })
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { ok: boolean; result?: { status?: string } };
  return body.ok ? body.result ?? null : null;
}
