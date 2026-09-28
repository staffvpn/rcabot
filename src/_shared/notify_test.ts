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
    async sendMessage(chatId) { sent.push(chatId); return { messageId: 1 }; },
    async sendPhoto() {}, async deleteMessage() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };

  await notifyAdmins(store, telegram, "hello");

  assertEquals(sent.sort(), [100, 200]);
});

Deno.test("notifyAdmins is a no-op when there are no admins yet", async () => {
  const store = createInMemoryStore();
  const sent: number[] = [];
  const telegram: TelegramClient = {
    async sendMessage(chatId) { sent.push(chatId); return { messageId: 1 }; },
    async sendPhoto() {}, async deleteMessage() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };

  await notifyAdmins(store, telegram, "hello");

  assertEquals(sent, []);
});

Deno.test("notifyAdmins does not throw when one admin is unreachable, and still messages the rest", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(1, "Заблокировал бота");
  await store.addAdmin(2, "Работает");
  const sent: number[] = [];
  const telegram: TelegramClient = {
    async sendMessage(chatId) {
      if (chatId === 1) throw new Error("Forbidden: bot can't initiate conversation with a user");
      sent.push(chatId);
      return { messageId: 1 };
    },
    async sendPhoto() {}, async deleteMessage() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };

  await notifyAdmins(store, telegram, "hello"); // must not reject

  assertEquals(sent, [2]);
});
