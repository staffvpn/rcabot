import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../_shared/store.ts";
import type { TelegramClient, TelegramUpdate } from "../_shared/telegram.ts";
import { handleUpdate } from "./handleUpdate.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string }[] = [];
  const answered: { id: string; text?: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); },
    async sendPhoto() {},
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
