import type { SendMessageOptions, TelegramClient } from "../_shared/telegram.ts";
import type { Store } from "../_shared/store.ts";

/**
 * Sends a "browsing" message (Инструкции navigation, admin panel) and deletes the previous one
 * this user was shown, so these steps replace each other in the chat instead of piling up.
 * Never use this for shift reports/notifications — those must stay in the chat permanently.
 */
export async function sendEphemeral(
  store: Store,
  telegram: TelegramClient,
  telegramId: number,
  chatId: number,
  text: string,
  opts?: SendMessageOptions,
): Promise<void> {
  const last = await store.getLastEphemeralMessage(telegramId);
  if (last) {
    await telegram.deleteMessage(last.chatId, last.messageId);
  }
  const sent = await telegram.sendMessage(chatId, text, opts);
  await store.setLastEphemeralMessage(telegramId, chatId, sent.messageId);
}

/** Deletes this user's last tracked ephemeral message, leaving nothing behind (e.g. on "Готово"). */
export async function clearEphemeral(store: Store, telegram: TelegramClient, telegramId: number): Promise<void> {
  const last = await store.getLastEphemeralMessage(telegramId);
  if (!last) return;
  await telegram.deleteMessage(last.chatId, last.messageId);
  await store.clearLastEphemeralMessage(telegramId);
}
