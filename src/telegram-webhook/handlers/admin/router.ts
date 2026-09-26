import type { Store } from "../../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient } from "../../../_shared/telegram.ts";
import { handleAdminMenuSelect } from "./menu.ts";
import { handleListEditorDelete, handleListEditorDone } from "./listEditor.ts";
import { LIST_EDITOR_CONFIGS } from "./listEditorConfigs.ts";

export async function routeAdminCallback(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const parts = callbackQuery.data.split(":");

  if (parts[1] === "menu" && parts[2]) {
    await handleAdminMenuSelect(store, telegram, callbackQuery, parts[2]);
    return;
  }

  if (parts[1] === "list" && parts[2] && parts[3] === "del" && parts[4]) {
    const config = LIST_EDITOR_CONFIGS[parts[2]];
    if (config) {
      await handleListEditorDelete(store, telegram, callbackQuery, config, parts[4]);
      return;
    }
  }

  if (parts[1] === "list" && parts[2] && parts[3] === "done") {
    await handleListEditorDone(store, telegram, callbackQuery);
    return;
  }

  await telegram.answerCallbackQuery(callbackQuery.id);
}
