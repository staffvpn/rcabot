import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";
import { handleListEditorAddText, handleListEditorDelete, handleListEditorDone, openListEditor } from "./listEditor.ts";
import { expiryConfig } from "./listEditorConfigs.ts";

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

Deno.test("openListEditor sends the prompt with a row per item, plus Готово, and starts the add-text session", async () => {
  const store = createInMemoryStore();
  await store.addExpiryItem("Канеле", 2);
  const { client, sent } = fakeTelegram();

  await openListEditor(store, client, 1, 1, expiryConfig);

  const keyboard = sent[0].replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assertEquals(keyboard.inline_keyboard.length, 2); // one item row + "Готово"
  assertEquals(keyboard.inline_keyboard[1][0].callback_data, "admin:list:expiry:done");
  assertEquals(await store.getSession(1), { state: "admin_list_add", data: { key: "expiry" } });
});

Deno.test("handleListEditorAddText with a valid line adds the row and re-sends the editor", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();
  const message: TelegramMessage = { message_id: 1, from: { id: 1, first_name: "RCA" }, chat: { id: 1 }, text: "Тирамису — 4 суток" };

  await handleListEditorAddText(store, client, message, expiryConfig);

  assertEquals((await store.listExpiryItems()).length, 1);
  assertEquals(sent[0].text, "Добавлено ✅");
});

Deno.test("handleListEditorAddText with an invalid line reports the error and adds nothing", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();
  const message: TelegramMessage = { message_id: 1, from: { id: 1, first_name: "RCA" }, chat: { id: 1 }, text: "просто текст" };

  await handleListEditorAddText(store, client, message, expiryConfig);

  assertEquals((await store.listExpiryItems()).length, 0);
  assertEquals(sent[0].text.includes("Формат"), true);
});

Deno.test("handleListEditorDelete removes the row and edits the keyboard in place", async () => {
  const store = createInMemoryStore();
  const item = await store.addExpiryItem("Канеле", 2);
  const { client, edited, answered } = fakeTelegram();
  const cbq: TelegramCallbackQuery = { id: "cbq", from: { id: 1, first_name: "RCA" }, message: { chat: { id: 1 }, message_id: 9 }, data: `admin:list:expiry:del:${item.id}` };

  await handleListEditorDelete(store, client, cbq, expiryConfig, item.id);

  assertEquals((await store.listExpiryItems()).length, 0);
  assertEquals(edited[0].messageId, 9);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("handleListEditorDone clears the add-text session so plain chat resumes", async () => {
  const store = createInMemoryStore();
  await store.setSession(1, "admin_list_add", { key: "expiry" });
  const { client, answered } = fakeTelegram();
  const cbq: TelegramCallbackQuery = { id: "cbq", from: { id: 1, first_name: "RCA" }, message: { chat: { id: 1 }, message_id: 9 }, data: "admin:list:expiry:done" };

  await handleListEditorDone(store, client, cbq);

  assertEquals((await store.getSession(1)).state, null);
  assertEquals(answered, [{ id: "cbq", text: "Сохранено." }]);
});
