import type { Store } from "../../../_shared/store.ts";
import type { InlineKeyboard, TelegramCallbackQuery, TelegramClient } from "../../../_shared/telegram.ts";
import { openListEditor } from "./listEditor.ts";
import { LIST_EDITOR_CONFIGS } from "./listEditorConfigs.ts";

export function renderAdminMenuKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "✏️ Чек-лист открытия", callback_data: "admin:menu:checklist_open" }],
      [{ text: "✅ Чек-лист закрытия", callback_data: "admin:menu:checklist_close" }],
      [{ text: "📖 Инструкции", callback_data: "admin:menu:instructions" }],
      [{ text: "🧑‍🍳 Сотрудники", callback_data: "admin:menu:employees" }],
      [{ text: "🍰 Сроки годности", callback_data: "admin:menu:expiry" }],
      [{ text: "🛡️ Администраторы", callback_data: "admin:menu:admins" }],
    ],
  };
}

export async function handleAdminMenuSelect(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  key: string,
): Promise<void> {
  const config = LIST_EDITOR_CONFIGS[key];
  if (config) {
    await openListEditor(store, telegram, callbackQuery.message.chat.id, callbackQuery.from.id, config);
    await telegram.answerCallbackQuery(callbackQuery.id);
    return;
  }
  // Инструкции / Сотрудники / Администраторы are wired in Tasks 12–13.
  await telegram.answerCallbackQuery(callbackQuery.id);
}
