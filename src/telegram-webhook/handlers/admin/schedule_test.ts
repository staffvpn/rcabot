import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";
import {
  handleScheduleAddStart, handleScheduleDateText, handleScheduleDelete,
  handleScheduleDone, handleSchedulePick, handleScheduleTimeText, openScheduleEditor,
} from "./schedule.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const edited: { chatId: number; messageId: number; markup: unknown }[] = [];
  const answered: { id: string; text?: string }[] = [];
  const deleted: { chatId: number; messageId: number }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); return { messageId: sent.length }; },
    async sendPhoto() {},
    async deleteMessage(chatId, messageId) { deleted.push({ chatId, messageId }); },
    async answerCallbackQuery(id, text) { answered.push({ id, text }); },
    async editMessageReplyMarkup(chatId, messageId, markup) { edited.push({ chatId, messageId, markup }); },
    async setWebhook() {},
  };
  return { client, sent, edited, answered, deleted };
}

function msg(fromId: number, text: string): TelegramMessage {
  return { message_id: 1, from: { id: fromId, first_name: "RCA" }, chat: { id: fromId }, text };
}

function cbq(data: string): TelegramCallbackQuery {
  return { id: "cbq", from: { id: 1, first_name: "RCA" }, message: { chat: { id: 1 }, message_id: 9 }, data };
}

Deno.test("openScheduleEditor lists upcoming assignments as 'DD.MM Имя start-end', plus Добавить and Готово", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  const { client, sent } = fakeTelegram();

  await openScheduleEditor(store, client, 1, 1);

  const keyboard = sent[0].replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assertEquals(keyboard.inline_keyboard[0][0].text, "30.09 Анна 08:30-14:30");
  assertEquals(keyboard.inline_keyboard.length, 3); // 1 row + Добавить + Готово
});

Deno.test("handleScheduleAddStart starts the date-capture session and prompts for it", async () => {
  const store = createInMemoryStore();
  const { client, sent, answered } = fakeTelegram();

  await handleScheduleAddStart(store, client, cbq("admin:schedule:add"));

  assertEquals(await store.getSession(1), { state: "admin_schedule_date", data: {} });
  assertEquals(sent[0].text.includes("30.09"), true);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("handleScheduleDateText with an invalid date re-prompts and keeps the session alive", async () => {
  const store = createInMemoryStore();
  await store.setSession(1, "admin_schedule_date", {});
  const { client, sent } = fakeTelegram();

  await handleScheduleDateText(store, client, msg(1, "не дата"));

  assertEquals(sent[0].text.includes("Не понял дату"), true);
  assertEquals((await store.getSession(1)).state, "admin_schedule_date");
});

Deno.test("handleScheduleDateText with a valid date moves to employee-picking and offers active employees", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  await store.addEmployee(2, "Иван");
  await store.setSession(10, "admin_schedule_date", {});
  const { client, sent } = fakeTelegram();

  await handleScheduleDateText(store, client, msg(10, "30.09"));

  assertEquals(await store.getSession(10), { state: "admin_schedule_employee", data: { date: "2026-09-30" } });
  const keyboard = sent[0].replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assertEquals(keyboard.inline_keyboard, [
    [{ text: "Анна", callback_data: "admin:schedule:pick:0" }],
    [{ text: "Иван", callback_data: "admin:schedule:pick:1" }],
  ]);
});

Deno.test("handleSchedulePick moves to time-capture, remembering the date and the picked employee", async () => {
  const store = createInMemoryStore();
  const anna = await store.addEmployee(1, "Анна");
  await store.addEmployee(2, "Иван");
  await store.setSession(1, "admin_schedule_employee", { date: "2026-09-30" });
  const { client, sent, answered } = fakeTelegram();

  await handleSchedulePick(store, client, cbq("admin:schedule:pick:0"), "0");

  assertEquals(await store.getSession(1), { state: "admin_schedule_time", data: { date: "2026-09-30", employeeId: anna.id } });
  assertEquals(sent[0].text.includes("08:30-14:30"), true);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("handleSchedulePick on an out-of-range index answers harmlessly and changes nothing", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  await store.setSession(1, "admin_schedule_employee", { date: "2026-09-30" });
  const { client, answered } = fakeTelegram();

  await handleSchedulePick(store, client, cbq("admin:schedule:pick:5"), "5");

  assertEquals((await store.getSession(1)).state, "admin_schedule_employee");
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("handleScheduleTimeText with an invalid time re-prompts and keeps the session alive", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.setSession(1, "admin_schedule_time", { date: "2026-09-30", employeeId: employee.id });
  const { client, sent } = fakeTelegram();

  await handleScheduleTimeText(store, client, msg(1, "весь день"));

  assertEquals(sent[0].text.includes("Не понял время"), true);
  assertEquals((await store.getSession(1)).state, "admin_schedule_time");
});

Deno.test("handleScheduleTimeText with a valid time saves the assignment, clears the session, and re-opens the editor", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.setSession(1, "admin_schedule_time", { date: "2026-09-30", employeeId: employee.id });
  const { client, sent } = fakeTelegram();

  await handleScheduleTimeText(store, client, msg(1, "08:30-14:30"));

  const rows = await store.listScheduleAssignmentsForDate("2026-09-30");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].startTime, "08:30");
  assertEquals((await store.getSession(1)).state, null);
  const last = sent[sent.length - 1];
  assertEquals(last.text, "Ближайший график:");
  const keyboard = last.replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assertEquals(keyboard.inline_keyboard[0][0].text, "30.09 Анна 08:30-14:30");
});

Deno.test("adding a second assignment for the same employee and date replaces the first, does not duplicate it", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  await store.setSession(1, "admin_schedule_time", { date: "2026-09-30", employeeId: employee.id });
  const { client } = fakeTelegram();

  await handleScheduleTimeText(store, client, msg(1, "09:00-15:00"));

  const rows = await store.listScheduleAssignmentsForDate("2026-09-30");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].startTime, "09:00");
});

Deno.test("handleScheduleDelete removes the row (addressed by list position) and edits the keyboard in place", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  const { client, edited, answered } = fakeTelegram();

  await handleScheduleDelete(store, client, cbq("admin:schedule:del:0"), "0");

  assertEquals((await store.listScheduleAssignmentsForDate("2026-09-30")).length, 0);
  assertEquals(edited[0].messageId, 9);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("deleting an assignment does not touch an already-created shift row for that date", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  const shift = await store.createShift(employee.id, "2026-09-30");
  await store.updateShift(shift.id, { status: "open", openedAt: "2026-09-30T08:23:00.000Z" });
  const { client } = fakeTelegram();

  await handleScheduleDelete(store, client, cbq("admin:schedule:del:0"), "0");

  const stillThere = await store.getShiftById(shift.id);
  assertEquals(stillThere?.status, "open");
  assertEquals(stillThere?.openedAt, "2026-09-30T08:23:00.000Z");
});

Deno.test("handleScheduleDelete on an out-of-range position answers harmlessly and changes nothing", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  const { client, edited, answered } = fakeTelegram();

  await handleScheduleDelete(store, client, cbq("admin:schedule:del:7"), "7");

  assertEquals((await store.listScheduleAssignmentsForDate("2026-09-30")).length, 1);
  assertEquals(edited, []);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("handleScheduleDone clears the session and deletes the last editor message", async () => {
  const store = createInMemoryStore();
  await store.setSession(1, "admin_schedule_date", {});
  await store.setLastEphemeralMessage(1, 1, 42);
  const { client, answered, deleted } = fakeTelegram();

  await handleScheduleDone(store, client, cbq("admin:schedule:done"));

  assertEquals((await store.getSession(1)).state, null);
  assertEquals(deleted, [{ chatId: 1, messageId: 42 }]);
  assertEquals(answered, [{ id: "cbq", text: "Сохранено." }]);
});
