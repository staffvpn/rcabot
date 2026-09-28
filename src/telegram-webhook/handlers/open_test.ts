import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import { todayDateKey } from "../../_shared/time.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { handleOpenButton, handleOpenCashAmount, handleOpenChecklistToggle } from "./open.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const edited: { chatId: number; messageId: number; markup: unknown }[] = [];
  const answered: { id: string; text?: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); return { messageId: sent.length }; },
    async sendPhoto() {},
    async deleteMessage() {},
    async answerCallbackQuery(id, text) { answered.push({ id, text }); },
    async editMessageReplyMarkup(chatId, messageId, markup) { edited.push({ chatId, messageId, markup }); },
    async setWebhook() {},
  };
  return { client, sent, edited, answered };
}

function openMessage(fromId: number, text: string): TelegramMessage {
  return { message_id: 1, from: { id: fromId, first_name: "Анна" }, chat: { id: fromId }, text };
}

function toggleCallback(fromId: number, itemId: string): TelegramCallbackQuery {
  return { id: "cbq", from: { id: fromId, first_name: "Анна" }, message: { chat: { id: fromId }, message_id: 7 }, data: `chk:open:${itemId}` };
}

function yesterdayDateKey(): string {
  return todayDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

Deno.test("OPEN with an already-open shift today tells the employee instead of restarting the checklist", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await handleOpenButton(store, client, openMessage(1, "🟢 OPEN"));

  assertEquals(sent, [{ chatId: 1, text: "Смена уже открыта.", replyMarkup: undefined }]);
});

Deno.test("OPEN with an already-closed shift today refuses to reopen it", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "closed" });
  const { client, sent } = fakeTelegram();

  await handleOpenButton(store, client, openMessage(1, "🟢 OPEN"));

  assertEquals(sent, [{ chatId: 1, text: "Смена на сегодня уже закрыта.", replyMarkup: undefined }]);
});

Deno.test("OPEN with zero configured open-checklist items skips the checklist entirely and asks for cash directly", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await handleOpenButton(store, client, openMessage(1, "🟢 OPEN"));

  assertEquals(sent.some((m) => m.text.includes("Перед открытием")), false);
  assertEquals(sent.some((m) => m.text.includes("сумму наличных")), true);
  assertEquals((await store.getSession(1)).state, "awaiting_open_cash");
});

Deno.test("OPEN with no shift yet creates one and shows the checklist", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.addChecklistItem("open", "Кофемашина прогрета", false);
  const { client, sent } = fakeTelegram();

  await handleOpenButton(store, client, openMessage(1, "🟢 OPEN"));

  assertEquals(sent.length, 1);
  assertEquals((sent[0].replyMarkup as { inline_keyboard: unknown[] }).inline_keyboard.length, 1);
  const shift = await store.getShift(employee.id, todayDateKey());
  assertEquals(shift?.status, "pending");
});

Deno.test("toggling the last open-checklist item edits the message and prompts for the cash amount", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  const item = await store.addChecklistItem("open", "Зал чистый", false);
  const { client, edited, sent, answered } = fakeTelegram();

  await handleOpenChecklistToggle(store, client, toggleCallback(1, item.id), item.id);

  assertEquals(edited.length, 1);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
  assertEquals(sent, [{ chatId: 1, text: "Чек-лист пройден. Введите сумму наличных в кассе (размен).", replyMarkup: undefined }]);

  const session = await store.getSession(1);
  assertEquals(session, { state: "awaiting_open_cash", data: { shiftId: shift.id } });
});

Deno.test("toggling before OPEN was pressed tells the employee to open first, without creating progress", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const item = await store.addChecklistItem("open", "Зал чистый", false);
  const { client, answered, edited } = fakeTelegram();

  await handleOpenChecklistToggle(store, client, toggleCallback(1, item.id), item.id);

  assertEquals(answered, [{ id: "cbq", text: "Сначала нажмите OPEN." }]);
  assertEquals(edited, []);
});

Deno.test("a non-numeric cash amount gets a re-prompt and does not open the shift", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  const { client, sent } = fakeTelegram();

  await handleOpenCashAmount(store, client, openMessage(1, "три тысячи"), shift.id);

  assertEquals(sent, [{ chatId: 1, text: "Не понял сумму. Введите число, например 3000.", replyMarkup: undefined }]);
  assertEquals((await store.getShiftById(shift.id))?.status, "pending");
});

Deno.test("a matching cash amount opens the shift with no discrepancy warning", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const yesterday = await store.createShift(employee.id, yesterdayDateKey());
  await store.updateShift(yesterday.id, { closingFloatAmount: 3000 });
  const shift = await store.createShift(employee.id, todayDateKey());
  const { client, sent } = fakeTelegram();

  await handleOpenCashAmount(store, client, openMessage(1, "3000"), shift.id);

  const updated = await store.getShiftById(shift.id);
  assertEquals(updated?.status, "open");
  assertEquals(updated?.cashDiscrepancy, 0);
  assertEquals(sent.some((m) => m.text.includes("⚠️")), false);
});

Deno.test("a mismatched cash amount warns the employee and notifies every admin", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const employee = await store.addEmployee(1, "Анна");
  const yesterday = await store.createShift(employee.id, yesterdayDateKey());
  await store.updateShift(yesterday.id, { closingFloatAmount: 3500 });
  const shift = await store.createShift(employee.id, todayDateKey());
  const { client, sent } = fakeTelegram();

  await handleOpenCashAmount(store, client, openMessage(1, "3000"), shift.id);

  const toEmployee = sent.filter((m) => m.chatId === 1);
  const toAdmin = sent.filter((m) => m.chatId === 999);
  assertEquals(toEmployee.some((m) => m.text.includes("⚠️")), true);
  assertEquals(toAdmin.some((m) => m.text.includes("Расхождение размена")), true);
});

Deno.test("the first-ever shift for an employee opens cleanly with no previous shift to compare against", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  const { client, sent } = fakeTelegram();

  await handleOpenCashAmount(store, client, openMessage(1, "3000"), shift.id);

  const updated = await store.getShiftById(shift.id);
  assertEquals(updated?.status, "open");
  assertEquals(updated?.cashDiscrepancy, null);
  assertEquals(sent.some((m) => m.text.includes("⚠️")), false);
});

Deno.test("an empty pending shift row (created ahead of time by the cron for a day nobody worked) does not mask the real previous close", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  // Two days ago: a real closed shift with a float amount.
  const twoDaysAgo = todayDateKey(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
  const realPrevious = await store.createShift(employee.id, twoDaysAgo);
  await store.updateShift(realPrevious.id, { status: "closed", closingFloatAmount: 3000 });
  // Yesterday: the cron already pre-created a shift row for the day (pending, never opened, no float).
  await store.createShift(employee.id, yesterdayDateKey());
  const shift = await store.createShift(employee.id, todayDateKey());
  const { client, sent } = fakeTelegram();

  await handleOpenCashAmount(store, client, openMessage(1, "3000"), shift.id);

  const updated = await store.getShiftById(shift.id);
  assertEquals(updated?.cashDiscrepancy, 0); // compared against the real 3000 close, not against null
  assertEquals(sent.some((m) => m.text.includes("⚠️")), false);
});

Deno.test("the comparison baseline is the venue's last close, even if a different employee closed it", async () => {
  const store = createInMemoryStore();
  const anna = await store.addEmployee(1, "Анна");
  const maria = await store.addEmployee(2, "Мария");
  const yesterday = await store.createShift(maria.id, yesterdayDateKey());
  await store.updateShift(yesterday.id, { status: "closed", closingFloatAmount: 3500 });
  const shift = await store.createShift(anna.id, todayDateKey());
  const { client, sent } = fakeTelegram();

  await handleOpenCashAmount(store, client, openMessage(1, "3000"), shift.id);

  const updated = await store.getShiftById(shift.id);
  assertEquals(updated?.cashDiscrepancy, -500);
  assertEquals(sent.some((m) => m.text.includes("⚠️")), true);
});
