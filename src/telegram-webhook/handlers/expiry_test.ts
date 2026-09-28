import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { handleExpiryList } from "./expiry.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string }[] = [];
  const deleted: { chatId: number; messageId: number }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); return { messageId: sent.length }; },
    async sendPhoto() {}, async deleteMessage(chatId, messageId) { deleted.push({ chatId, messageId }); },
    async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };
  return { client, sent, deleted };
}

function msg(): TelegramMessage {
  return { message_id: 1, from: { id: 1, first_name: "Анна" }, chat: { id: 1 }, text: "🍰 Сроки годности" };
}

Deno.test("a stranger (not a registered employee or admin) gets no response from the expiry list", async () => {
  const store = createInMemoryStore();
  await store.addExpiryItem("Канеле", 2);
  const { client, sent } = fakeTelegram();

  await handleExpiryList(store, client, { message_id: 1, from: { id: 999, first_name: "Чужой" }, chat: { id: 999 }, text: "🍰 Сроки годности" });

  assertEquals(sent, []);
});

Deno.test("an empty expiry list says so instead of sending a blank list", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await handleExpiryList(store, client, msg());

  assertEquals(sent, [{ chatId: 1, text: "Список сроков годности пока пуст." }]);
});

Deno.test("tapping Сроки годности again deletes the previous listing instead of piling up a new one", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  await store.addExpiryItem("Канеле", 2);
  const { client, sent, deleted } = fakeTelegram();

  await handleExpiryList(store, client, msg());
  await handleExpiryList(store, client, msg());

  assertEquals(sent.length, 2);
  assertEquals(deleted, [{ chatId: 1, messageId: 1 }]);
});

Deno.test("the expiry list is formatted as one 'name — N суток' line per item, in position order, with the supplier reference link appended", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  await store.addExpiryItem("Канеле", 2);
  await store.addExpiryItem("Чизкейк", 3);
  const { client, sent } = fakeTelegram();

  await handleExpiryList(store, client, msg());

  assertEquals(sent, [{
    chatId: 1,
    text: "СРОКИ ГОДНОСТИ\nКанеле — 2 суток\nЧизкейк — 3 суток\n\n🔗 Полный ассортимент: https://www.zhirnova.net",
  }]);
});
