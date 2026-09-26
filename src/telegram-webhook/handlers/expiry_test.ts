import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { handleExpiryList } from "./expiry.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); },
    async sendPhoto() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };
  return { client, sent };
}

function msg(): TelegramMessage {
  return { message_id: 1, from: { id: 1, first_name: "Анна" }, chat: { id: 1 }, text: "🍰 Сроки годности" };
}

Deno.test("an empty expiry list says so instead of sending a blank list", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleExpiryList(store, client, msg());

  assertEquals(sent, [{ chatId: 1, text: "Список сроков годности пока пуст." }]);
});

Deno.test("the expiry list is formatted as one 'name — N суток' line per item, in position order", async () => {
  const store = createInMemoryStore();
  await store.addExpiryItem("Канеле", 2);
  await store.addExpiryItem("Чизкейк", 3);
  const { client, sent } = fakeTelegram();

  await handleExpiryList(store, client, msg());

  assertEquals(sent, [{ chatId: 1, text: "СРОКИ ГОДНОСТИ\nКанеле — 2 суток\nЧизкейк — 3 суток" }]);
});
