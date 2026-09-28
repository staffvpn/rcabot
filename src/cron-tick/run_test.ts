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

// 2026-09-21 is a Monday: schedule is 08:30-19:30, venue offset UTC+3.
function atVenueTime(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 8, 21, h - 3, m));
}

Deno.test("an employee 9 minutes from opening gets the reminder exactly once across repeated ticks", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:21"));
  await runCronTick(store, client, atVenueTime("08:22")); // a second tick a minute later must not re-send

  const reminders = sent.filter((m) => m.chatId === 1 && m.text.includes("Через 10 минут открытие"));
  assertEquals(reminders.length, 1);
});

Deno.test("an employee who never opens gets exactly one lateness notice to admins, not one per tick", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:30"));
  await runCronTick(store, client, atVenueTime("08:35"));

  const lateNotices = sent.filter((m) => m.chatId === 999 && m.text.includes("Опоздание"));
  assertEquals(lateNotices.length, 1);
});

Deno.test("two employees who both never open produce exactly one lateness notice to admins, not one per employee", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  await store.addEmployee(1, "Анна");
  await store.addEmployee(2, "Мария");
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:30"));

  const lateNotices = sent.filter((m) => m.chatId === 999 && m.text.includes("Опоздание"));
  assertEquals(lateNotices.length, 1);
});

Deno.test("an open shift past 14:20 gets the X-report reminder with the 'Ввести отчёт' button", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-21");
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("14:20"));

  const reminder = sent.find((m) => m.chatId === 1 && m.text.includes("контрольного X-отчёта"));
  assertEquals(reminder?.replyMarkup, { inline_keyboard: [[{ text: "Ввести отчёт", callback_data: "xreport:start" }]] });
});

Deno.test("an inactive employee is skipped entirely", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Уволена");
  await store.removeEmployee(employee.id); // no longer listed by listEmployees
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:30"));

  assertEquals(sent.filter((m) => m.chatId === 1).length, 0);
});

Deno.test("a shift already closed today is left alone (no reminders re-fire after closing)", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-21");
  await store.updateShift(shift.id, { status: "closed" });
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("19:25"));

  assertEquals(sent.filter((m) => m.chatId === 1).length, 0);
});
