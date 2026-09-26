const TELEGRAM_API = "https://api.telegram.org";

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: { id: number };
  text?: string;
  photo?: { file_id: string }[];
  forward_from?: TelegramUser;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message: { chat: { id: number }; message_id: number };
  data: string;
}

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface ReplyKeyboard {
  keyboard: string[][];
  resize_keyboard: true;
}

export type ReplyMarkup = InlineKeyboard | ReplyKeyboard | { remove_keyboard: true };

export interface SendMessageOptions {
  replyMarkup?: ReplyMarkup;
}

export interface TelegramClient {
  sendMessage(chatId: number, text: string, opts?: SendMessageOptions): Promise<void>;
  sendPhoto(chatId: number, fileId: string, caption?: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  editMessageReplyMarkup(chatId: number, messageId: number, markup: InlineKeyboard): Promise<void>;
  setWebhook(url: string, secretToken: string): Promise<void>;
}

export function createTelegramClient(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): TelegramClient {
  async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetchImpl(`${TELEGRAM_API}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Telegram API ${method} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  return {
    async sendMessage(chatId, text, opts) {
      await call("sendMessage", { chat_id: chatId, text, reply_markup: opts?.replyMarkup });
    },
    async sendPhoto(chatId, fileId, caption) {
      await call("sendPhoto", { chat_id: chatId, photo: fileId, caption });
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    },
    async editMessageReplyMarkup(chatId, messageId, markup) {
      await call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup });
    },
    async setWebhook(url, secretToken) {
      await call("setWebhook", { url, secret_token: secretToken });
    },
  };
}
