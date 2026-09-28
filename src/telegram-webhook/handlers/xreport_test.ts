import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import { todayDateKey } from "../../_shared/time.ts";
import type { TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { handleXreportButton, handleXreportCash, handleXreportCashless } from "./xreport.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); return { messageId: sent.length }; },
    async sendPhoto() {}, async deleteMessage() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };
  return { client, sent };
}

function msg(fromId: number, text: string): TelegramMessage {
  return { message_id: 1, from: { id: fromId, first_name: "Анна" }, chat: { id: fromId }, text };
}

Deno.test("the X-report button without an open shift tells the employee to open first", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await handleXreportButton(store, client, msg(1, "🧾 Контрольный X-отчёт"));

  assertEquals(sent, [{ chatId: 1, text: "Сначала откройте смену кнопкой OPEN." }]);
  assertEquals((await store.getSession(1)).state, null);
});

Deno.test("the X-report button with an open shift asks for the cash amount", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await handleXreportButton(store, client, msg(1, "🧾 Контрольный X-отчёт"));

  assertEquals(sent, [{ chatId: 1, text: "Введите наличные:" }]);
  assertEquals(await store.getSession(1), { state: "awaiting_xreport_cash", data: { shiftId: shift.id } });
});

Deno.test("a non-numeric cash figure re-prompts without advancing to the cashless question", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleXreportCash(store, client, msg(1, "много"), "shift-1");

  assertEquals(sent, [{ chatId: 1, text: "Не понял сумму. Введите число, например 18400." }]);
});

Deno.test("a numeric cash figure moves on to asking for cashless, remembering the cash figure", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleXreportCash(store, client, msg(1, "18400"), "shift-1");

  assertEquals(sent, [{ chatId: 1, text: "Введите безналичные:" }]);
  assertEquals(await store.getSession(1), { state: "awaiting_xreport_cashless", data: { shiftId: "shift-1", cash: 18400 } });
});

Deno.test("a non-numeric cashless figure re-prompts and does not save the report", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  const { client, sent } = fakeTelegram();

  await handleXreportCashless(store, client, msg(1, "хз"), shift.id, 18400);

  assertEquals(sent, [{ chatId: 1, text: "Не понял сумму. Введите число, например 42150." }]);
  assertEquals((await store.getShiftById(shift.id))?.xreportCash, null);
});

Deno.test("a numeric cashless figure saves the report, confirms to the employee, and notifies admins", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, todayDateKey());
  const { client, sent } = fakeTelegram();

  await handleXreportCashless(store, client, msg(1, "42150"), shift.id, 18400);

  const updated = await store.getShiftById(shift.id);
  assertEquals(updated?.xreportCash, 18400);
  assertEquals(updated?.xreportCashless, 42150);
  assertEquals(sent.some((m) => m.chatId === 1 && m.text === "Принято, спасибо ✅"), true);
  const adminMessage = sent.find((m) => m.chatId === 999)?.text ?? "";
  assertEquals(adminMessage.includes("нал: 18400"), true);
  assertEquals(adminMessage.includes("безнал: 42150"), true);
  assertEquals((await store.getSession(1)).state, null);
});
