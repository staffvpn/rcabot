import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../_shared/store.ts";
import type { TelegramClient } from "../_shared/telegram.ts";
import { runCronTick } from "./run.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); return { messageId: sent.length }; },
    async sendPhoto() {}, async deleteMessage() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };
  return { client, sent };
}

// 2026-09-21 is a Monday.
function atVenueTime(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 8, 21, h - 3, m));
}

Deno.test("a scheduled employee 9 minutes from their own start time gets the reminder exactly once across repeated ticks", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "19:30");
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:21"));
  await runCronTick(store, client, atVenueTime("08:22")); // a second tick a minute later must not re-send

  const reminders = sent.filter((m) => m.chatId === 1 && m.text.includes("Через 10 минут открытие"));
  assertEquals(reminders.length, 1);
});

Deno.test("an employee with no schedule assignment for today gets no reminder and no lateness check, even past opening time", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна"); // registered, but not scheduled for today
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:35"));

  assertEquals(sent.filter((m) => m.chatId === 1).length, 0);
});

Deno.test("the lateness notice names the specific scheduled employee and their own start time", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const employee = await store.addEmployee(1, "Вика");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "14:30");
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:30"));

  const lateNotice = sent.find((m) => m.chatId === 999 && m.text.includes("Опоздание"));
  assertEquals(lateNotice?.text, "🔴 Опоздание: Вика не открыл(а) смену вовремя (по графику 08:30).");
});

Deno.test("a scheduled employee who never opens gets exactly one lateness notice, not one per tick", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "19:30");
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:30"));
  await runCronTick(store, client, atVenueTime("08:35"));

  const lateNotices = sent.filter((m) => m.chatId === 999 && m.text.includes("Опоздание"));
  assertEquals(lateNotices.length, 1);
});

Deno.test("two employees scheduled the same day with different start times who are both late get two separate notices, not deduped", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const morning = await store.addEmployee(1, "Вика");
  const afternoon = await store.addEmployee(2, "Сабина");
  await store.upsertScheduleAssignment(morning.id, "2026-09-21", "08:30", "14:30");
  await store.upsertScheduleAssignment(afternoon.id, "2026-09-21", "14:30", "20:00");
  const { client, sent } = fakeTelegram();

  // Past both start times; neither has opened.
  await runCronTick(store, client, atVenueTime("15:00"));

  const lateNotices = sent.filter((m) => m.chatId === 999 && m.text.includes("Опоздание"));
  assertEquals(lateNotices.length, 2);
  assertEquals(lateNotices.some((m) => m.text.includes("Вика")), true);
  assertEquals(lateNotices.some((m) => m.text.includes("Сабина")), true);
});

Deno.test("an open shift past 14:20 gets the X-report reminder with the 'Ввести отчёт' button", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "19:30");
  const shift = await store.createShift(employee.id, "2026-09-21");
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("14:20"));

  const reminder = sent.find((m) => m.chatId === 1 && m.text.includes("контрольного X-отчёта"));
  assertEquals(reminder?.replyMarkup, { inline_keyboard: [[{ text: "Ввести отчёт", callback_data: "xreport:start" }]] });
});

Deno.test("an employee who opened a shift without a schedule assignment (covering for someone) still gets the close reminder", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Сабина"); // no schedule assignment for today at all
  const shift = await store.createShift(employee.id, "2026-09-21");
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("19:20")); // 10 min before the venue's own 19:30 close

  const reminder = sent.find((m) => m.chatId === 1 && m.text.includes("Через 10 минут закрытие"));
  assertEquals(reminder !== undefined, true);
});

Deno.test("an employee who opened a shift without a schedule assignment still gets the X-report prompt past 14:20", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Сабина");
  const shift = await store.createShift(employee.id, "2026-09-21");
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("14:20"));

  const reminder = sent.find((m) => m.chatId === 1 && m.text.includes("контрольного X-отчёта"));
  assertEquals(reminder?.replyMarkup, { inline_keyboard: [[{ text: "Ввести отчёт", callback_data: "xreport:start" }]] });
});

Deno.test("a shift with a schedule assignment is not double-processed by the unassigned-open-shift pass", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "19:30");
  const shift = await store.createShift(employee.id, "2026-09-21");
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("19:20"));

  const reminders = sent.filter((m) => m.chatId === 1 && m.text.includes("Через 10 минут закрытие"));
  assertEquals(reminders.length, 1);
});

Deno.test("an inactive employee is skipped even if a schedule assignment still exists for them", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Уволена");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "19:30");
  await store.removeEmployee(employee.id); // soft-delete; the assignment row is untouched
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:30"));

  assertEquals(sent.filter((m) => m.chatId === 1).length, 0);
});

Deno.test("a shift already closed today is left alone (no reminders re-fire after closing)", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "19:30");
  const shift = await store.createShift(employee.id, "2026-09-21");
  await store.updateShift(shift.id, { status: "closed" });
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("19:25"));

  assertEquals(sent.filter((m) => m.chatId === 1).length, 0);
});
