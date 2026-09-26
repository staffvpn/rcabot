import type { Store } from "../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../_shared/telegram.ts";
import { handleStart } from "./handlers/start.ts";

export async function handleMessage(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  if (message.text === "/start") {
    await handleStart(store, telegram, message);
    return;
  }

  await telegram.sendMessage(message.chat.id, "Не понимаю эту команду. Используйте кнопки внизу экрана.");
}
