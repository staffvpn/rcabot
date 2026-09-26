import type { Store } from "./store.ts";
import type { TelegramClient } from "./telegram.ts";

export async function notifyAdmins(store: Store, telegram: TelegramClient, text: string): Promise<void> {
  const admins = await store.listAdmins();
  for (const admin of admins) {
    await telegram.sendMessage(admin.telegramId, text);
  }
}
