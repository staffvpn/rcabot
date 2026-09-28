import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../_shared/store.ts";
import type { TelegramClient, TelegramUpdate } from "../_shared/telegram.ts";
import { handleUpdate } from "./handleUpdate.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string }[] = [];
  const answered: { id: string; text?: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); return { messageId: sent.length }; },
    async sendPhoto() {},
    async deleteMessage() {}, async getChatByUsername() { return null; },
    async answerCallbackQuery(id, text) { answered.push({ id, text }); },
    async editMessageReplyMarkup() {},
    async setWebhook() {},
  };
  return { client, sent, answered };
}

Deno.test("an unrecognized text message gets a fallback reply", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();
  const update: TelegramUpdate = {
    update_id: 1,
    message: { message_id: 1, from: { id: 1, first_name: "Аня" }, chat: { id: 1 }, text: "asdf" },
  };

  await handleUpdate(store, client, update);

  assertEquals(sent.length, 1);
  assertEquals(sent[0].chatId, 1);
});

Deno.test("an unrecognized callback query is answered with no visible text", async () => {
  const store = createInMemoryStore();
  const { client, answered } = fakeTelegram();
  const update: TelegramUpdate = {
    update_id: 2,
    callback_query: { id: "cbq-1", from: { id: 1, first_name: "Аня" }, message: { chat: { id: 1 }, message_id: 5 }, data: "unknown:thing" },
  };

  await handleUpdate(store, client, update);

  assertEquals(answered, [{ id: "cbq-1", text: undefined }]);
});

Deno.test("an update with neither message nor callback_query is a no-op", async () => {
  const store = createInMemoryStore();
  const { client, sent, answered } = fakeTelegram();

  await handleUpdate(store, client, { update_id: 3 });

  assertEquals(sent.length, 0);
  assertEquals(answered.length, 0);
});

Deno.test("the OPEN button is routed to the open-shift handler, not the fallback reply", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();
  const update: TelegramUpdate = {
    update_id: 4,
    message: { message_id: 1, from: { id: 1, first_name: "Анна" }, chat: { id: 1 }, text: "🟢 OPEN" },
  };

  await handleUpdate(store, client, update);

  assertEquals(sent.some((m) => m.text.includes("Не понимаю")), false);
});

Deno.test("/start escapes a stuck session state instead of being swallowed as its input", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  await store.setSession(1, "awaiting_open_cash", { shiftId: "some-shift" });
  const { client, sent } = fakeTelegram();
  const update: TelegramUpdate = {
    update_id: 6,
    message: { message_id: 1, from: { id: 1, first_name: "Анна" }, chat: { id: 1 }, text: "/start" },
  };

  await handleUpdate(store, client, update);

  assertEquals(sent.some((m) => m.text.includes("С возвращением")), true);
  assertEquals(sent.some((m) => m.text.includes("Не понял сумму")), false);
});

Deno.test("/admin escapes a stuck session state instead of being swallowed as its input", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(1, "Мария");
  await store.setSession(1, "awaiting_close_photo");
  const { client, sent } = fakeTelegram();
  const update: TelegramUpdate = {
    update_id: 7,
    message: { message_id: 1, from: { id: 1, first_name: "Мария" }, chat: { id: 1 }, text: "/admin" },
  };

  await handleUpdate(store, client, update);

  assertEquals(sent.some((m) => m.text.includes("Панель администратора")), true);
});

Deno.test("a non-admin tapping an admin: callback is silently rejected, no menu leaks", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна"); // registered, but not an admin
  const { client, sent, answered } = fakeTelegram();
  const update: TelegramUpdate = {
    update_id: 5,
    callback_query: { id: "cbq", from: { id: 1, first_name: "Анна" }, message: { chat: { id: 1 }, message_id: 1 }, data: "admin:menu:expiry" },
  };

  await handleUpdate(store, client, update);

  assertEquals(sent.length, 0);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});
