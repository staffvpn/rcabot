import type { Store } from "../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { formatVenueTime, todayDateKey } from "../../_shared/time.ts";
import { notifyAdmins } from "../../_shared/notify.ts";

async function startXreport(
  store: Store,
  telegram: TelegramClient,
  telegramId: number,
  chatId: number,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(telegramId);
  if (!employee) return;

  const shift = await store.getShift(employee.id, todayDateKey());
  if (!shift || shift.status !== "open") {
    await telegram.sendMessage(chatId, "Сначала откройте смену кнопкой OPEN.");
    return;
  }

  await store.setSession(telegramId, "awaiting_xreport_cash", { shiftId: shift.id });
  await telegram.sendMessage(chatId, "Введите наличные:");
}

export async function handleXreportButton(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  await startXreport(store, telegram, message.from.id, message.chat.id);
}

export async function handleXreportStartCallback(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  await startXreport(store, telegram, callbackQuery.from.id, callbackQuery.message.chat.id);
  await telegram.answerCallbackQuery(callbackQuery.id);
}

export async function handleXreportCash(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
  shiftId: string,
): Promise<void> {
  const amount = Number((message.text ?? "").replace(",", ".").trim());
  if (!message.text || Number.isNaN(amount) || amount < 0) {
    await telegram.sendMessage(message.chat.id, "Не понял сумму. Введите число, например 18400.");
    return;
  }

  await store.setSession(message.from.id, "awaiting_xreport_cashless", { shiftId, cash: amount });
  await telegram.sendMessage(message.chat.id, "Введите безналичные:");
}

export async function handleXreportCashless(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
  shiftId: string,
  cash: number,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(message.from.id);
  if (!employee) return;

  const amount = Number((message.text ?? "").replace(",", ".").trim());
  if (!message.text || Number.isNaN(amount) || amount < 0) {
    await telegram.sendMessage(message.chat.id, "Не понял сумму. Введите число, например 42150.");
    return;
  }

  const now = new Date().toISOString();
  await store.updateShift(shiftId, { xreportCash: cash, xreportCashless: amount, xreportAt: now });
  await store.clearSession(message.from.id);

  await telegram.sendMessage(message.chat.id, "Принято, спасибо ✅");
  await notifyAdmins(
    store,
    telegram,
    `🧾 X-отчёт, ${employee.fullName} — ${formatVenueTime(now)}\nнал: ${cash} ₽\nбезнал: ${amount} ₽`,
  );
}
