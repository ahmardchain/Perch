// A thin Telegram Bot API client: just fetch, so the Worker stays small.

import type { Env } from "./env";

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

async function call<T = unknown>(env: Env, method: string, body: Record<string, unknown>): Promise<T | undefined> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!json.ok) {
    console.log(`telegram ${method} failed: ${json.description ?? res.status}`);
    return undefined;
  }
  return json.result;
}

export function send(env: Env, chatId: number | string, text: string, buttons?: InlineButton[][]) {
  return call(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

export function edit(env: Env, chatId: number, messageId: number, text: string, buttons?: InlineButton[][]) {
  return call(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buttons ?? [] },
  });
}

export function answerCallback(env: Env, id: string, text?: string) {
  return call(env, "answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}

export function setWebhook(env: Env, url: string) {
  return call(env, "setWebhook", {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}

export function setCommands(env: Env) {
  return call(env, "setMyCommands", {
    commands: [
      { command: "markets", description: "Mark price and funding for the top markets" },
      { command: "account", description: "Equity, health and open positions" },
      { command: "long", description: "Open a long: /long BTC 50" },
      { command: "short", description: "Open a short: /short ETH 50" },
      { command: "close", description: "Close a position: /close BTC" },
      { command: "alerts", description: "Turn alerts and the guard on or off" },
      { command: "digest", description: "Funding digest now" },
      { command: "help", description: "How Perch works" },
    ],
  });
}

/** Escape text for Telegram's HTML parse mode. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
