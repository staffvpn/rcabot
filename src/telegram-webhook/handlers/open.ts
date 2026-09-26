import type { Store } from "../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { formatVenueTime, todayDateKey } from "../../_shared/time.ts";
import { notifyAdmins } from "../../_shared/notify.ts";
import { isChecklistComplete, renderChecklistKeyboard } from "../checklist.ts";
import { renderEmployeeKeyboard } from "../keyboards.ts";

export async function handleOpenButton(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(message.from.id);
  if (!employee) return;

  const today = todayDateKey();
  const existing = await store.getShift(employee.id, today);

  if (existing?.status === "open") {
    await telegram.sendMessage(message.chat.id, "Смена уже открыта.");
    return;
  }
  if (existing?.status === "closed") {
    await telegram.sendMessage(message.chat.id, "Смена на сегодня уже закрыта.");
    return;
  }

  const shift = existing ?? (await store.createShift(employee.id, today));
  const items = await store.listChecklistItems("open");
  const progress = await store.getChecklistProgress(shift.id);

  await telegram.sendMessage(message.chat.id, "Перед открытием отметьте пункты:", {
    replyMarkup: renderChecklistKeyboard(items, progress),
  });
}

export async function handleOpenChecklistToggle(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  itemId: string,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(callbackQuery.from.id);
  if (!employee) { await telegram.answerCallbackQuery(callbackQuery.id); return; }

  const today = todayDateKey();
  const shift = await store.getShift(employee.id, today);
  if (!shift || shift.status !== "pending") {
    await telegram.answerCallbackQuery(callbackQuery.id, "Сначала нажмите OPEN.");
    return;
  }

  const items = await store.listChecklistItems("open");
  const item = items.find((i) => i.id === itemId);
  if (!item) { await telegram.answerCallbackQuery(callbackQuery.id); return; }

  await store.setChecklistProgress(shift.id, item.id, true);
  const progress = await store.getChecklistProgress(shift.id);

  await telegram.editMessageReplyMarkup(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    renderChecklistKeyboard(items, progress),
  );
  await telegram.answerCallbackQuery(callbackQuery.id);

  if (isChecklistComplete(items, progress)) {
    await store.setSession(callbackQuery.from.id, "awaiting_open_cash", { shiftId: shift.id });
    await telegram.sendMessage(
      callbackQuery.message.chat.id,
      "Чек-лист пройден. Введите сумму наличных в кассе (размен).",
    );
  }
}

export async function handleOpenCashAmount(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
  shiftId: string,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(message.from.id);
  if (!employee) return;

  const amount = Number((message.text ?? "").replace(",", ".").trim());
  if (!message.text || Number.isNaN(amount) || amount < 0) {
    await telegram.sendMessage(message.chat.id, "Не понял сумму. Введите число, например 3000.");
    return;
  }

  const shift = await store.getShiftById(shiftId);
  if (!shift) return;

  const previous = await store.getPreviousShift(employee.id, shift.shiftDate);
  const expected = previous?.closingFloatAmount ?? null;
  const discrepancy = expected === null ? null : Math.round((amount - expected) * 100) / 100;

  const updated = await store.updateShift(shift.id, {
    openCashAmount: amount,
    cashDiscrepancy: discrepancy,
    openedAt: new Date().toISOString(),
    status: "open",
  });

  await store.clearSession(message.from.id);

  if (discrepancy !== null && discrepancy !== 0) {
    await telegram.sendMessage(
      message.chat.id,
      `⚠️ Вчера смена закрылась с ${expected} ₽. Расхождение ${Math.abs(discrepancy)} ₽. Админ уведомлён.`,
    );
    await notifyAdmins(
      store,
      telegram,
      `⚠️ Расхождение размена у ${employee.fullName}: заявлено ${amount} ₽, ожидалось ${expected} ₽ (${discrepancy > 0 ? "+" : ""}${discrepancy} ₽).`,
    );
  }

  await telegram.sendMessage(message.chat.id, "Смена открыта ✅", {
    replyMarkup: renderEmployeeKeyboard(updated),
  });
  await notifyAdmins(
    store,
    telegram,
    `🟢 ${employee.fullName} открыла смену в ${formatVenueTime(updated.openedAt!)}.`,
  );
}
