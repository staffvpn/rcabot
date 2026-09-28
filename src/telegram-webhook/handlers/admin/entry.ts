import type { Store } from "../../../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";
import { UNKNOWN_COMMAND_TEXT } from "../../messages.ts";
import { sendEphemeral } from "../../ephemeral.ts";
import { renderAdminMenuKeyboard } from "./menu.ts";

export async function handleAdminEntry(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const admin = await store.getAdminByTelegramId(message.from.id);
  if (!admin) {
    await telegram.sendMessage(message.chat.id, UNKNOWN_COMMAND_TEXT);
    return;
  }
  await sendEphemeral(store, telegram, message.from.id, message.chat.id, "Панель администратора:", {
    replyMarkup: renderAdminMenuKeyboard(),
  });
}
