import type { Store } from "../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient } from "../_shared/telegram.ts";

export async function handleCallbackQuery(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  await telegram.answerCallbackQuery(callbackQuery.id);
}
