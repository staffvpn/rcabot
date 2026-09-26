import type { Store } from "../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../_shared/telegram.ts";
import { UNKNOWN_COMMAND_TEXT } from "./messages.ts";
import { handleStart } from "./handlers/start.ts";
import { handleOpenButton, handleOpenCashAmount } from "./handlers/open.ts";
import { handleCloserButton, handleClosePhoto, handleClosingFloatAmount } from "./handlers/close.ts";
import { handleXreportButton, handleXreportCash, handleXreportCashless } from "./handlers/xreport.ts";
import { handleInstructionsMenu } from "./handlers/instructions.ts";
import { handleExpiryList } from "./handlers/expiry.ts";
import { handleAdminEntry } from "./handlers/admin/entry.ts";
import { handleListEditorAddText } from "./handlers/admin/listEditor.ts";
import { LIST_EDITOR_CONFIGS } from "./handlers/admin/listEditorConfigs.ts";
import { handleInstructionBody, handleInstructionTitle } from "./handlers/admin/instructions.ts";
import { handlePeopleForward, PEOPLE_EDITOR_CONFIGS } from "./handlers/admin/peopleEditor.ts";

export async function handleMessage(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const session = await store.getSession(message.from.id);

  if (session.state === "awaiting_open_cash") {
    await handleOpenCashAmount(store, telegram, message, session.data.shiftId as string);
    return;
  }
  if (session.state === "awaiting_close_photo") {
    await handleClosePhoto(store, telegram, message);
    return;
  }
  if (session.state === "awaiting_closing_float") {
    await handleClosingFloatAmount(store, telegram, message, session.data.shiftId as string);
    return;
  }
  if (session.state === "awaiting_xreport_cash") {
    await handleXreportCash(store, telegram, message, session.data.shiftId as string);
    return;
  }
  if (session.state === "awaiting_xreport_cashless") {
    await handleXreportCashless(store, telegram, message, session.data.shiftId as string, session.data.cash as number);
    return;
  }
  if (session.state === "admin_list_add") {
    const admin = await store.getAdminByTelegramId(message.from.id);
    const config = admin ? LIST_EDITOR_CONFIGS[session.data.key as string] : undefined;
    if (config) await handleListEditorAddText(store, telegram, message, config);
    return;
  }
  if (session.state === "admin_instruction_title") {
    if (await store.getAdminByTelegramId(message.from.id)) {
      await handleInstructionTitle(store, telegram, message);
    }
    return;
  }
  if (session.state === "admin_instruction_body") {
    if (await store.getAdminByTelegramId(message.from.id)) {
      await handleInstructionBody(store, telegram, message, session.data.title as string);
    }
    return;
  }
  if (session.state === "admin_people_add") {
    const admin = await store.getAdminByTelegramId(message.from.id);
    const config = admin ? PEOPLE_EDITOR_CONFIGS[session.data.key as string] : undefined;
    if (config) await handlePeopleForward(store, telegram, message, config);
    return;
  }

  if (message.text === "/start") {
    await handleStart(store, telegram, message);
    return;
  }
  if (message.text === "🟢 OPEN") {
    await handleOpenButton(store, telegram, message);
    return;
  }
  if (message.text === "🔴 CLOSER") {
    await handleCloserButton(store, telegram, message);
    return;
  }
  if (message.text === "🧾 Контрольный X-отчёт") {
    await handleXreportButton(store, telegram, message);
    return;
  }
  if (message.text === "📖 Инструкции") {
    await handleInstructionsMenu(store, telegram, message);
    return;
  }
  if (message.text === "🍰 Сроки годности") {
    await handleExpiryList(store, telegram, message);
    return;
  }
  if (message.text === "/admin") {
    await handleAdminEntry(store, telegram, message);
    return;
  }

  await telegram.sendMessage(message.chat.id, UNKNOWN_COMMAND_TEXT);
}
