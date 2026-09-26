import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { todayDateKey } from "../../_shared/time.ts";
import { handleStart } from "./start.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); },
    async sendPhoto() {},
    async answerCallbackQuery() {},
    async editMessageReplyMarkup() {},
    async setWebhook() {},
  };
  return { client, sent };
}

function startMessage(fromId: number): TelegramMessage {
  return { message_id: 1, from: { id: fromId, first_name: "Тест" }, chat: { id: fromId }, text: "/start" };
}

Deno.test("an unregistered user is told to contact the admin, with no keyboard", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleStart(store, client, startMessage(999));

  assertEquals(sent.length, 1);
  assertEquals(sent[0].text.includes("не зарегистрированы"), true);
  assertEquals(sent[0].replyMarkup, undefined);
});

Deno.test("a registered employee with no shift today gets the OPEN panel", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await handleStart(store, client, startMessage(1));

  assertEquals(sent[0].replyMarkup, {
    keyboard: [["🟢 OPEN"], ["🧾 Контрольный X-отчёт"], ["📖 Инструкции", "🍰 Сроки годности"]],
    resize_keyboard: true,
  });
});

Deno.test("a registered employee with an open shift today gets the CLOSER panel", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await handleStart(store, client, startMessage(1));

  assertEquals((sent[0].replyMarkup as { keyboard: string[][] }).keyboard[0], ["🔴 CLOSER"]);
});

Deno.test("an admin who is not also an employee gets pointed at /admin, with no shift panel", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(1, "RCA");
  const { client, sent } = fakeTelegram();

  await handleStart(store, client, startMessage(1));

  assertEquals(sent[0].text.includes("/admin"), true);
  assertEquals(sent[0].replyMarkup, undefined);
});
