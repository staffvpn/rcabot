import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "./store.ts";
import type { TelegramClient } from "./telegram.ts";
import { notifyAdmins } from "./notify.ts";

Deno.test("notifyAdmins sends the same text to every admin", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(100, "RCA");
  await store.addAdmin(200, "Мария");
  const sent: number[] = [];
  const telegram: TelegramClient = {
    async sendMessage(chatId) { sent.push(chatId); },
    async sendPhoto() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };

  await notifyAdmins(store, telegram, "hello");

  assertEquals(sent.sort(), [100, 200]);
});

Deno.test("notifyAdmins is a no-op when there are no admins yet", async () => {
  const store = createInMemoryStore();
  const sent: number[] = [];
  const telegram: TelegramClient = {
    async sendMessage(chatId) { sent.push(chatId); },
    async sendPhoto() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };

  await notifyAdmins(store, telegram, "hello");

  assertEquals(sent, []);
});
