import type { Store } from "../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../_shared/telegram.ts";
import { handleStart } from "./handlers/start.ts";
import { handleOpenButton, handleOpenCashAmount } from "./handlers/open.ts";
import { handleCloserButton, handleClosePhoto, handleClosingFloatAmount } from "./handlers/close.ts";
import { handleXreportButton, handleXreportCash, handleXreportCashless } from "./handlers/xreport.ts";

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

  await telegram.sendMessage(message.chat.id, "Не понимаю эту команду. Используйте кнопки внизу экрана.");
}
