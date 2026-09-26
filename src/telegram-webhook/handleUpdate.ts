import type { Store } from "../_shared/store.ts";
import type { TelegramClient, TelegramUpdate } from "../_shared/telegram.ts";
import { handleMessage } from "./router.ts";
import { handleCallbackQuery } from "./callbackRouter.ts";

export async function handleUpdate(
  store: Store,
  telegram: TelegramClient,
  update: TelegramUpdate,
): Promise<void> {
  if (update.message) {
    await handleMessage(store, telegram, update.message);
  } else if (update.callback_query) {
    await handleCallbackQuery(store, telegram, update.callback_query);
  }
}
