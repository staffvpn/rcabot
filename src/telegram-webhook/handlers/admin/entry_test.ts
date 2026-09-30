import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";
import { UNKNOWN_COMMAND_TEXT } from "../../messages.ts";
import { handleAdminEntry } from "./entry.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const deleted: { chatId: number; messageId: number }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); return { messageId: sent.length }; },
    async sendPhoto() {}, async deleteMessage(chatId, messageId) { deleted.push({ chatId, messageId }); },
    async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };
  return { client, sent, deleted };
}

function msg(fromId: number): TelegramMessage {
  return { message_id: 1, from: { id: fromId, first_name: "Кто-то" }, chat: { id: fromId }, text: "/admin" };
}

Deno.test("/admin from a non-admin gets the same reply as an unrecognized command — no menu leaks", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleAdminEntry(store, client, msg(1));

  assertEquals(sent, [{ chatId: 1, text: UNKNOWN_COMMAND_TEXT, replyMarkup: undefined }]);
});

Deno.test("/admin from a registered admin shows the seven-section menu", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(1, "RCA");
  const { client, sent } = fakeTelegram();

  await handleAdminEntry(store, client, msg(1));

  assertEquals(sent[0].text, "Панель администратора:");
  assertEquals((sent[0].replyMarkup as { inline_keyboard: unknown[] }).inline_keyboard.length, 7);
});
