import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";
import {
  adminsConfig, employeesConfig, extractForwardedUser,
  handlePeopleAddStart, handlePeopleDelete, handlePeopleDone, handlePeopleForward, openPeopleEditor,
} from "./peopleEditor.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const edited: { chatId: number; messageId: number; markup: unknown }[] = [];
  const answered: { id: string; text?: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); },
    async sendPhoto() {},
    async answerCallbackQuery(id, text) { answered.push({ id, text }); },
    async editMessageReplyMarkup(chatId, messageId, markup) { edited.push({ chatId, messageId, markup }); },
    async setWebhook() {},
  };
  return { client, sent, edited, answered };
}

function forwardedMsg(fromId: number, forwardFromId?: number): TelegramMessage {
  return {
    message_id: 1, from: { id: fromId, first_name: "RCA" }, chat: { id: fromId }, text: "переслано",
    forward_from: forwardFromId ? { id: forwardFromId, first_name: "Мария" } : undefined,
  };
}

function cbq(data: string): TelegramCallbackQuery {
  return { id: "cbq", from: { id: 1, first_name: "RCA" }, message: { chat: { id: 1 }, message_id: 9 }, data };
}

Deno.test("extractForwardedUser reads the id and name off a forwarded message", () => {
  const result = extractForwardedUser(forwardedMsg(1, 555));
  assertEquals(result, { telegramId: 555, fullName: "Мария" });
});

Deno.test("extractForwardedUser returns null for a message that was not forwarded", () => {
  assertEquals(extractForwardedUser(forwardedMsg(1)), null);
});

Deno.test("openPeopleEditor lists current people plus Добавить and Готово", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await openPeopleEditor(store, client, 1, employeesConfig);

  const keyboard = sent[0].replyMarkup as { inline_keyboard: unknown[][] };
  assertEquals(keyboard.inline_keyboard.length, 3); // Анна + Добавить + Готово
});

Deno.test("handlePeopleAddStart starts the forward-capture session and explains what to do", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handlePeopleAddStart(store, client, cbq("admin:people:employees:add"), employeesConfig);

  assertEquals(await store.getSession(1), { state: "admin_people_add", data: { key: "employees" } });
  assertEquals(sent[0].text.includes("/start"), true);
  assertEquals(sent[0].text.includes("администратора"), false); // this prompt is shared with employeesConfig — wording must stay generic
});

Deno.test("a non-forwarded message while adding is rejected without creating anyone", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handlePeopleForward(store, client, forwardedMsg(1), employeesConfig);

  assertEquals((await store.listEmployees()).length, 0);
  assertEquals(sent[0].text.includes("не похоже на пересланное"), true);
});

Deno.test("forwarding a message adds the employee, confirms, and re-opens the list", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handlePeopleForward(store, client, forwardedMsg(1, 555), employeesConfig);

  const employees = await store.listEmployees();
  assertEquals(employees[0].telegramId, 555);
  assertEquals(employees[0].fullName, "Мария");
  assertEquals(sent.some((m) => m.text.includes("Добавлен")), true);
  assertEquals((await store.getSession(1)).state, null);
});

Deno.test("deleting a non-last admin succeeds and edits the keyboard", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(1, "RCA");
  const second = await store.addAdmin(2, "Мария");
  const { client, edited, answered } = fakeTelegram();

  await handlePeopleDelete(store, client, cbq(`admin:people:admins:del:${second.id}`), adminsConfig, second.id);

  assertEquals((await store.listAdmins()).length, 1);
  assertEquals(edited.length, 1);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("deleting the last remaining admin fails with a clear message instead of crashing or succeeding", async () => {
  const store = createInMemoryStore();
  const only = await store.addAdmin(1, "RCA");
  const { client, edited, answered } = fakeTelegram();

  await handlePeopleDelete(store, client, cbq(`admin:people:admins:del:${only.id}`), adminsConfig, only.id);

  assertEquals((await store.listAdmins()).length, 1);
  assertEquals(edited.length, 0);
  assertEquals(answered[0].text?.includes("last remaining admin"), true);
});

Deno.test("handlePeopleDone clears any lingering add-capture session", async () => {
  const store = createInMemoryStore();
  await store.setSession(1, "admin_people_add", { key: "admins" });
  const { client, answered } = fakeTelegram();

  await handlePeopleDone(store, client, cbq("admin:people:admins:done"));

  assertEquals((await store.getSession(1)).state, null);
  assertEquals(answered, [{ id: "cbq", text: "Сохранено." }]);
});
