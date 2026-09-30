import type { Store } from "../../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient } from "../../../_shared/telegram.ts";
import { handleAdminMenuSelect } from "./menu.ts";
import { handleListEditorDelete, handleListEditorDone } from "./listEditor.ts";
import { LIST_EDITOR_CONFIGS } from "./listEditorConfigs.ts";
import { handleInstructionsAddStart, handleInstructionsDelete, handleInstructionsDone } from "./instructions.ts";
import { handlePeopleAddStart, handlePeopleDelete, handlePeopleDone, PEOPLE_EDITOR_CONFIGS } from "./peopleEditor.ts";
import { handleScheduleAddStart, handleScheduleDelete, handleScheduleDone, handleSchedulePick } from "./schedule.ts";

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

  if (parts[1] === "instr" && parts[2] === "add") {
    await handleInstructionsAddStart(store, telegram, callbackQuery);
    return;
  }
  if (parts[1] === "instr" && parts[2] === "del" && parts[3]) {
    await handleInstructionsDelete(store, telegram, callbackQuery, parts[3]);
    return;
  }
  if (parts[1] === "instr" && parts[2] === "done") {
    await handleInstructionsDone(store, telegram, callbackQuery);
    return;
  }

  if (parts[1] === "people" && parts[2] && parts[3] === "add") {
    const config = PEOPLE_EDITOR_CONFIGS[parts[2]];
    if (config) {
      await handlePeopleAddStart(store, telegram, callbackQuery, config);
      return;
    }
  }
  if (parts[1] === "people" && parts[2] && parts[3] === "del" && parts[4]) {
    const config = PEOPLE_EDITOR_CONFIGS[parts[2]];
    if (config) {
      await handlePeopleDelete(store, telegram, callbackQuery, config, parts[4]);
      return;
    }
  }
  if (parts[1] === "people" && parts[2] && parts[3] === "done") {
    await handlePeopleDone(store, telegram, callbackQuery);
    return;
  }

  if (parts[1] === "schedule" && parts[2] === "add") {
    await handleScheduleAddStart(store, telegram, callbackQuery);
    return;
  }
  if (parts[1] === "schedule" && parts[2] === "pick" && parts[3]) {
    await handleSchedulePick(store, telegram, callbackQuery, parts[3]);
    return;
  }
  if (parts[1] === "schedule" && parts[2] === "del" && parts[3]) {
    await handleScheduleDelete(store, telegram, callbackQuery, parts[3]);
    return;
  }
  if (parts[1] === "schedule" && parts[2] === "done") {
    await handleScheduleDone(store, telegram, callbackQuery);
    return;
  }

  await telegram.answerCallbackQuery(callbackQuery.id);
}
