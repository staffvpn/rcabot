import type { Store } from "../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../_shared/telegram.ts";

export async function handleMessage(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  await telegram.sendMessage(message.chat.id, "Не понимаю эту команду. Используйте кнопки внизу экрана.");
}
