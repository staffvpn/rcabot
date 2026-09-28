import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import { todayDateKey } from "../../_shared/time.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { handleCloserButton, handleCloseChecklistToggle, handleClosePhoto, handleClosingFloatAmount } from "./close.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const photos: { chatId: number; fileId: string }[] = [];
  const edited: { chatId: number; messageId: number; markup: unknown }[] = [];
  const answered: { id: string; text?: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); return { messageId: sent.length }; },
    async sendPhoto(chatId, fileId) { photos.push({ chatId, fileId }); },
    async deleteMessage() {}, async getChatByUsername() { return null; },
    async answerCallbackQuery(id, text) { answered.push({ id, text }); },
    async editMessageReplyMarkup(chatId, messageId, markup) { edited.push({ chatId, messageId, markup }); },
    async setWebhook() {},
  };
  return { client, sent, photos, edited, answered };
}

function msg(fromId: number, text?: string, photo?: { file_id: string }[]): TelegramMessage {
  return { message_id: 1, from: { id: fromId, first_name: "Анна" }, chat: { id: fromId }, text, photo };
}

function toggle(fromId: number, itemId: string, messageId = 7): TelegramCallbackQuery {
  return { id: "cbq", from: { id: fromId, first_name: "Анна" }, message: { chat: { id: fromId }, message_id: messageId }, data: `chk:close:${itemId}` };
}

Deno.test("CLOSER before the shift was ever opened tells the employee to open first", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await handleCloserButton(store, client, msg(1, "🔴 CLOSER"));

  assertEquals(sent, [{ chatId: 1, text: "Сначала откройте смену кнопкой OPEN.", replyMarkup: undefined }]);
});

Deno.test("CLOSER when the shift is already closed today tells the employee, not a second checklist", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "closed" });
  const { client, sent } = fakeTelegram();

  await handleCloserButton(store, client, msg(1, "🔴 CLOSER"));

  assertEquals(sent, [{ chatId: 1, text: "Смена уже закрыта.", replyMarkup: undefined }]);
});

Deno.test("CLOSER with zero configured close-checklist items skips the checklist entirely and asks for the closing float directly", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await handleCloserButton(store, client, msg(1, "🔴 CLOSER"));

  assertEquals(sent.some((m) => m.text.includes("Перед закрытием")), false);
  assertEquals(sent.some((m) => m.text.includes("Сколько наличных")), true);
  assertEquals((await store.getSession(1)).state, "awaiting_closing_float");
  assertEquals((await store.getSession(1)).data, { shiftId: shift.id });
});

Deno.test("CLOSER on an open shift shows the closing checklist", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "open" });
  await store.addChecklistItem("close", "Фото отчёта с кассы", true);
  const { client, sent } = fakeTelegram();

  await handleCloserButton(store, client, msg(1, "🔴 CLOSER"));

  assertEquals(sent.length, 1);
  assertEquals((sent[0].replyMarkup as { inline_keyboard: unknown[] }).inline_keyboard.length, 1);
});

Deno.test("toggling a non-photo close item marks it done immediately and edits the keyboard", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "open" });
  const item = await store.addChecklistItem("close", "Выключить кофемашину", false);
  const { client, edited, answered } = fakeTelegram();

  await handleCloseChecklistToggle(store, client, toggle(1, item.id), item.id);

  assertEquals(edited.length, 1);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
  assertEquals((await store.getChecklistProgress(shift.id))[0].done, true);
});

Deno.test("toggling a photo-required item does not mark it done — it asks for a photo instead", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "open" });
  const item = await store.addChecklistItem("close", "Фото отчёта с кассы", true);
  const { client, sent, edited } = fakeTelegram();

  await handleCloseChecklistToggle(store, client, toggle(1, item.id), item.id);

  assertEquals(edited, []);
  assertEquals(sent, [{ chatId: 1, text: "Пришлите фото: Фото отчёта с кассы 📎", replyMarkup: undefined }]);
  assertEquals(await store.getChecklistProgress(shift.id), []);

  const session = await store.getSession(1);
  assertEquals(session.state, "awaiting_close_photo");
  assertEquals(session.data, { shiftId: shift.id, checklistItemId: item.id, chatId: 1, messageId: 7 });
});

Deno.test("tapping an item that is already done answers with 'already marked' and changes nothing", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "open" });
  const item = await store.addChecklistItem("close", "Сдать ключи", false);
  await store.setChecklistProgress(shift.id, item.id, true);
  const { client, answered, edited } = fakeTelegram();

  await handleCloseChecklistToggle(store, client, toggle(1, item.id), item.id);

  assertEquals(answered, [{ id: "cbq", text: "Уже отмечено." }]);
  assertEquals(edited, []);
});

Deno.test("a text message while awaiting a photo is rejected and re-asks for a photo", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  await store.setSession(1, "awaiting_close_photo", { shiftId: "s1", checklistItemId: "i1", chatId: 1, messageId: 7 });
  const { client, sent } = fakeTelegram();

  await handleClosePhoto(store, client, msg(1, "вот фото словами"));

  assertEquals(sent, [{ chatId: 1, text: "Нужно фото. Пришлите его как изображение.", replyMarkup: undefined }]);
});

Deno.test("sending the photo completes the only close item and moves straight to the closing-float question", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "open" });
  const item = await store.addChecklistItem("close", "Фото отчёта с кассы", true);
  await store.setSession(1, "awaiting_close_photo", { shiftId: shift.id, checklistItemId: item.id, chatId: 1, messageId: 7 });
  const { client, sent, edited } = fakeTelegram();

  await handleClosePhoto(store, client, msg(1, undefined, [{ file_id: "small" }, { file_id: "biggest" }]));

  const progress = await store.getChecklistProgress(shift.id);
  assertEquals(progress[0].done, true);
  assertEquals(progress[0].photoFileId, "biggest");
  assertEquals(edited, [{ chatId: 1, messageId: 7, markup: { inline_keyboard: [[{ text: "✅ Фото отчёта с кассы", callback_data: `chk:close:${item.id}` }]] } }]);
  assertEquals(sent, [{ chatId: 1, text: "Сколько наличных (размена) оставляете в кассе для следующей смены?", replyMarkup: undefined }]);
  assertEquals((await store.getSession(1)).state, "awaiting_closing_float");
});

Deno.test("a non-numeric closing float amount gets a re-prompt and the shift stays open", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await handleClosingFloatAmount(store, client, msg(1, "не знаю"), shift.id);

  assertEquals(sent, [{ chatId: 1, text: "Не понял сумму. Введите число, например 3000.", replyMarkup: undefined }]);
  assertEquals((await store.getShiftById(shift.id))?.status, "open");
});

Deno.test("a valid closing float amount closes the shift, confirms to the employee, and notifies admins", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "open" });
  const item = await store.addChecklistItem("close", "Фото отчёта с кассы", true);
  await store.setChecklistProgress(shift.id, item.id, true, "the-photo-id");
  const { client, sent, photos } = fakeTelegram();

  await handleClosingFloatAmount(store, client, msg(1, "3000"), shift.id);

  const updated = await store.getShiftById(shift.id);
  assertEquals(updated?.status, "closed");
  assertEquals(updated?.closingFloatAmount, 3000);
  assertEquals(sent.some((m) => m.chatId === 1 && m.text.includes("Смена закрыта")), true);
  assertEquals(sent.some((m) => m.chatId === 999 && m.text.includes("закрыла смену")), true);
  assertEquals(photos, [{ chatId: 999, fileId: "the-photo-id" }]);
  assertEquals((await store.getSession(1)).state, null);
});
