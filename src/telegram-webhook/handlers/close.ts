import type { Store } from "../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { formatVenueTime, todayDateKey } from "../../_shared/time.ts";
import { notifyAdmins } from "../../_shared/notify.ts";
import { isChecklistComplete, renderChecklistKeyboard } from "../checklist.ts";
import { renderEmployeeKeyboard } from "../keyboards.ts";
import type { ChecklistItem, ChecklistProgress } from "../../_shared/store.ts";

export async function handleCloserButton(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(message.from.id);
  if (!employee) return;

  const today = todayDateKey();
  const shift = await store.getShift(employee.id, today);

  if (!shift || shift.status === "pending") {
    await telegram.sendMessage(message.chat.id, "Сначала откройте смену кнопкой OPEN.");
    return;
  }
  if (shift.status === "closed") {
    await telegram.sendMessage(message.chat.id, "Смена уже закрыта.");
    return;
  }

  const items = await store.listChecklistItems("close");
  const progress = await store.getChecklistProgress(shift.id);
  await telegram.sendMessage(message.chat.id, "Перед закрытием отметьте пункты:", {
    replyMarkup: renderChecklistKeyboard(items, progress),
  });
}

export async function handleCloseChecklistToggle(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  itemId: string,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(callbackQuery.from.id);
  if (!employee) { await telegram.answerCallbackQuery(callbackQuery.id); return; }

  const today = todayDateKey();
  const shift = await store.getShift(employee.id, today);
  if (!shift || shift.status !== "open") {
    await telegram.answerCallbackQuery(callbackQuery.id, "Сначала нажмите CLOSER.");
    return;
  }

  const items = await store.listChecklistItems("close");
  const item = items.find((i) => i.id === itemId);
  if (!item) { await telegram.answerCallbackQuery(callbackQuery.id); return; }

  const progress = await store.getChecklistProgress(shift.id);
  if (progress.find((p) => p.checklistItemId === item.id)?.done) {
    await telegram.answerCallbackQuery(callbackQuery.id, "Уже отмечено.");
    return;
  }

  if (item.requiresPhoto) {
    await store.setSession(callbackQuery.from.id, "awaiting_close_photo", {
      shiftId: shift.id,
      checklistItemId: item.id,
      chatId: callbackQuery.message.chat.id,
      messageId: callbackQuery.message.message_id,
    });
    await telegram.answerCallbackQuery(callbackQuery.id);
    await telegram.sendMessage(callbackQuery.message.chat.id, `Пришлите фото: ${item.label} 📎`);
    return;
  }

  await store.setChecklistProgress(shift.id, item.id, true);
  const updatedProgress = await store.getChecklistProgress(shift.id);

  await telegram.editMessageReplyMarkup(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    renderChecklistKeyboard(items, updatedProgress),
  );
  await telegram.answerCallbackQuery(callbackQuery.id);

  await maybeAskClosingFloat(store, telegram, callbackQuery.message.chat.id, callbackQuery.from.id, items, updatedProgress);
}

export async function handleClosePhoto(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const session = await store.getSession(message.from.id);
  const data = session.data as { shiftId: string; checklistItemId: string; chatId: number; messageId: number };

  if (!message.photo || message.photo.length === 0) {
    await telegram.sendMessage(message.chat.id, "Нужно фото. Пришлите его как изображение.");
    return;
  }
  const fileId = message.photo[message.photo.length - 1].file_id;

  await store.setChecklistProgress(data.shiftId, data.checklistItemId, true, fileId);
  await store.clearSession(message.from.id);

  const items = await store.listChecklistItems("close");
  const progress = await store.getChecklistProgress(data.shiftId);

  await telegram.editMessageReplyMarkup(data.chatId, data.messageId, renderChecklistKeyboard(items, progress));

  await maybeAskClosingFloat(store, telegram, message.chat.id, message.from.id, items, progress);
}

async function maybeAskClosingFloat(
  store: Store,
  telegram: TelegramClient,
  chatId: number,
  telegramId: number,
  items: ChecklistItem[],
  progress: ChecklistProgress[],
): Promise<void> {
  if (!isChecklistComplete(items, progress)) return;
  const shiftId = progress[0].shiftId;
  await store.setSession(telegramId, "awaiting_closing_float", { shiftId });
  await telegram.sendMessage(chatId, "Сколько наличных (размена) оставляете в кассе для следующей смены?");
}

export async function handleClosingFloatAmount(
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

  const updated = await store.updateShift(shiftId, {
    closingFloatAmount: amount,
    closedAt: new Date().toISOString(),
    status: "closed",
  });
  await store.clearSession(message.from.id);

  await telegram.sendMessage(message.chat.id, "Смена закрыта ✅ Хорошего вечера!", {
    replyMarkup: renderEmployeeKeyboard(updated),
  });

  await notifyAdmins(
    store,
    telegram,
    `🔴 ${employee.fullName} закрыла смену в ${formatVenueTime(updated.closedAt!)}. Оставлено в кассе: ${amount} ₽.`,
  );

  const progress = await store.getChecklistProgress(shiftId);
  const photoItem = progress.find((p) => p.photoFileId);
  if (photoItem?.photoFileId) {
    const admins = await store.listAdmins();
    for (const admin of admins) {
      await telegram.sendPhoto(admin.telegramId, photoItem.photoFileId);
    }
  }
}
