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

export interface MessageOriginUser {
  type: "user";
  sender_user: TelegramUser;
}

export interface MessageOriginHiddenUser {
  type: "hidden_user";
  sender_user_name: string;
}

export interface MessageOriginOther {
  type: "chat" | "channel";
}

export type MessageOrigin = MessageOriginUser | MessageOriginHiddenUser | MessageOriginOther;

export interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: { id: number };
  text?: string;
  photo?: { file_id: string }[];
  /** @deprecated replaced by forward_origin in Bot API 7.0; kept only as a fallback for old clients/fixtures */
  forward_from?: TelegramUser;
  forward_origin?: MessageOrigin;
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

export interface SentMessage {
  messageId: number;
}

export interface ResolvedChat {
  telegramId: number;
  fullName: string;
}

export interface TelegramClient {
  sendMessage(chatId: number, text: string, opts?: SendMessageOptions): Promise<SentMessage>;
  sendPhoto(chatId: number, fileId: string, caption?: string): Promise<void>;
  /** Best-effort: swallows failures (message already gone, too old, etc.) instead of throwing. */
  deleteMessage(chatId: number, messageId: number): Promise<void>;
  /**
   * Resolves a public @username to their id — only works if that person has messaged this bot
   * at least once (Telegram doesn't let bots resolve arbitrary usernames otherwise). Returns
   * null on any failure, or if the username belongs to something other than a private chat.
   */
  getChatByUsername(username: string): Promise<ResolvedChat | null>;
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
      const result = (await call("sendMessage", { chat_id: chatId, text, reply_markup: opts?.replyMarkup })) as {
        result: { message_id: number };
      };
      return { messageId: result.result.message_id };
    },
    async sendPhoto(chatId, fileId, caption) {
      await call("sendPhoto", { chat_id: chatId, photo: fileId, caption });
    },
    async deleteMessage(chatId, messageId) {
      try {
        await call("deleteMessage", { chat_id: chatId, message_id: messageId });
      } catch (err) {
        console.error("deleteMessage: best-effort cleanup failed", err);
      }
    },
    async getChatByUsername(username) {
      const handle = username.startsWith("@") ? username : `@${username}`;
      try {
        const data = (await call("getChat", { chat_id: handle })) as {
          result: { id: number; type: string; first_name?: string };
        };
        if (data.result.type !== "private") return null;
        return { telegramId: data.result.id, fullName: data.result.first_name || handle };
      } catch {
        return null;
      }
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
