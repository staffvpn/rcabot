import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient } from "../../../_shared/telegram.ts";
import { routeAdminCallback } from "./router.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const edited: unknown[] = [];
  const answered: { id: string; text?: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); },
    async sendPhoto() {},
    async answerCallbackQuery(id, text) { answered.push({ id, text }); },
    async editMessageReplyMarkup(...args) { edited.push(args); },
    async setWebhook() {},
  };
  return { client, sent, edited, answered };
}

function cbq(data: string): TelegramCallbackQuery {
  return { id: "cbq", from: { id: 1, first_name: "RCA" }, message: { chat: { id: 1 }, message_id: 9 }, data };
}

Deno.test("admin:menu:expiry opens the expiry list editor", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await routeAdminCallback(store, client, cbq("admin:menu:expiry"));

  assertEquals(sent[0].text.includes("сроков годности"), true);
});

Deno.test("admin:menu:instructions opens the instructions editor", async () => {
  const store = createInMemoryStore();
  const { client, sent, answered } = fakeTelegram();

  await routeAdminCallback(store, client, cbq("admin:menu:instructions"));

  assertEquals(sent[0].text, "Разделы инструкций:");
  assertEquals(answered.length, 1);
});

Deno.test("admin:list:expiry:del:<index> deletes the row at that position", async () => {
  const store = createInMemoryStore();
  await store.addExpiryItem("Канеле", 2);
  const { client } = fakeTelegram();

  await routeAdminCallback(store, client, cbq("admin:list:expiry:del:0"));

  assertEquals((await store.listExpiryItems()).length, 0);
});

Deno.test("admin:list:expiry:done clears the session", async () => {
  const store = createInMemoryStore();
  await store.setSession(1, "admin_list_add", { key: "expiry" });
  const { client } = fakeTelegram();

  await routeAdminCallback(store, client, cbq("admin:list:expiry:done"));

  assertEquals((await store.getSession(1)).state, null);
});

Deno.test("an unrecognized admin: callback is answered harmlessly instead of crashing", async () => {
  const store = createInMemoryStore();
  const { client, answered } = fakeTelegram();

  await routeAdminCallback(store, client, cbq("admin:unknown:thing"));

  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});
