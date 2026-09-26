import type { Store } from "../../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";

export async function handleExpiryList(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const items = await store.listExpiryItems();
  if (items.length === 0) {
    await telegram.sendMessage(message.chat.id, "Список сроков годности пока пуст.");
    return;
  }
  const lines = items.map((i) => `${i.name} — ${i.shelfLifeDays} суток`);
  await telegram.sendMessage(message.chat.id, `СРОКИ ГОДНОСТИ\n${lines.join("\n")}`);
}
