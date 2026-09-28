import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../_shared/store.ts";
import type { TelegramClient } from "../_shared/telegram.ts";
import { clearEphemeral, sendEphemeral } from "./ephemeral.ts";

function fakeTelegram() {
  let nextId = 1;
  const sent: { chatId: number; text: string }[] = [];
  const deleted: { chatId: number; messageId: number }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); return { messageId: nextId++ }; },
    async sendPhoto() {},
    async deleteMessage(chatId, messageId) { deleted.push({ chatId, messageId }); }, async getChatByUsername() { return null; },
    async answerCallbackQuery() {},
    async editMessageReplyMarkup() {},
    async setWebhook() {},
  };
  return { client, sent, deleted };
}

Deno.test("sendEphemeral sends the message and remembers it, with nothing to delete the first time", async () => {
  const store = createInMemoryStore();
  const { client, sent, deleted } = fakeTelegram();

  await sendEphemeral(store, client, 1, 1, "первое сообщение");

  assertEquals(sent, [{ chatId: 1, text: "первое сообщение" }]);
  assertEquals(deleted, []);
  assertEquals(await store.getLastEphemeralMessage(1), { chatId: 1, messageId: 1 });
});

Deno.test("sendEphemeral deletes the previous ephemeral message before sending the next one", async () => {
  const store = createInMemoryStore();
  const { client, sent, deleted } = fakeTelegram();

  await sendEphemeral(store, client, 1, 1, "первое");
  await sendEphemeral(store, client, 1, 1, "второе");

  assertEquals(sent.map((m) => m.text), ["первое", "второе"]);
  assertEquals(deleted, [{ chatId: 1, messageId: 1 }]);
  assertEquals(await store.getLastEphemeralMessage(1), { chatId: 1, messageId: 2 });
});

Deno.test("sendEphemeral tracks separately per telegram id", async () => {
  const store = createInMemoryStore();
  const { client, deleted } = fakeTelegram();

  await sendEphemeral(store, client, 1, 1, "у Ани");
  await sendEphemeral(store, client, 2, 2, "у Марии");

  assertEquals(deleted, []); // different users, nothing to replace for either
});

Deno.test("clearEphemeral deletes the last tracked message and forgets it", async () => {
  const store = createInMemoryStore();
  const { client, deleted } = fakeTelegram();
  await sendEphemeral(store, client, 1, 1, "что-то");

  await clearEphemeral(store, client, 1);

  assertEquals(deleted, [{ chatId: 1, messageId: 1 }]);
  assertEquals(await store.getLastEphemeralMessage(1), null);
});

Deno.test("clearEphemeral is a no-op when there is nothing tracked", async () => {
  const store = createInMemoryStore();
  const { client, deleted } = fakeTelegram();

  await clearEphemeral(store, client, 1); // must not throw

  assertEquals(deleted, []);
});
