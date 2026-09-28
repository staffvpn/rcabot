import type { Store } from "./store.ts";
import type { TelegramClient } from "./telegram.ts";

export async function notifyAdmins(store: Store, telegram: TelegramClient, text: string): Promise<void> {
  const admins = await store.listAdmins();
  // One admin being unreachable (blocked the bot, never started a chat with it, ...) must never
  // abort the caller — the shift/report has already been written by this point in every handler.
  const results = await Promise.allSettled(admins.map((admin) => telegram.sendMessage(admin.telegramId, text)));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("notifyAdmins: failed to reach an admin", result.reason);
    }
  }
}
