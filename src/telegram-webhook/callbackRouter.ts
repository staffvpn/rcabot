import type { Store } from "../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient } from "../_shared/telegram.ts";
import { handleOpenChecklistToggle } from "./handlers/open.ts";
import { handleCloseChecklistToggle } from "./handlers/close.ts";
import { handleXreportStartCallback } from "./handlers/xreport.ts";
import { handleInstructionShow } from "./handlers/instructions.ts";

export async function handleCallbackQuery(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const [kind, phase, itemId] = callbackQuery.data.split(":");

  if (kind === "chk" && phase === "open" && itemId) {
    await handleOpenChecklistToggle(store, telegram, callbackQuery, itemId);
    return;
  }
  if (kind === "chk" && phase === "close" && itemId) {
    await handleCloseChecklistToggle(store, telegram, callbackQuery, itemId);
    return;
  }
  if (callbackQuery.data === "xreport:start") {
    await handleXreportStartCallback(store, telegram, callbackQuery);
    return;
  }
  if (kind === "instr" && phase === "show" && itemId) {
    await handleInstructionShow(store, telegram, callbackQuery, itemId);
    return;
  }

  await telegram.answerCallbackQuery(callbackQuery.id);
}
