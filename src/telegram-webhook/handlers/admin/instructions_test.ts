import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";
import {
  handleInstructionBody, handleInstructionsAddStart, handleInstructionsDelete,
  handleInstructionsDone, handleInstructionTitle, openInstructionsEditor,
} from "./instructions.ts";

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

function msg(text: string): TelegramMessage {
  return { message_id: 1, from: { id: 1, first_name: "RCA" }, chat: { id: 1 }, text };
}

function cbq(data: string): TelegramCallbackQuery {
  return { id: "cbq", from: { id: 1, first_name: "RCA" }, message: { chat: { id: 1 }, message_id: 9 }, data };
}

Deno.test("an empty instructions list still shows Добавить and Готово", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await openInstructionsEditor(store, client, 1);

  const keyboard = sent[0].replyMarkup as { inline_keyboard: unknown[][] };
  assertEquals(keyboard.inline_keyboard.length, 2);
});

Deno.test("handleInstructionsAddStart starts the title-capture session and prompts for it", async () => {
  const store = createInMemoryStore();
  const { client, sent, answered } = fakeTelegram();

  await handleInstructionsAddStart(store, client, cbq("admin:instr:add"));

  assertEquals(await store.getSession(1), { state: "admin_instruction_title", data: {} });
  assertEquals(sent[0].text.includes("заголовок"), true);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("an empty title is rejected and the session stays put", async () => {
  const store = createInMemoryStore();
  await store.setSession(1, "admin_instruction_title", {});
  const { client, sent } = fakeTelegram();

  await handleInstructionTitle(store, client, msg("   "));

  assertEquals(sent[0].text.includes("не может быть пустым"), true);
  assertEquals((await store.getSession(1)).state, "admin_instruction_title");
});

Deno.test("a valid title moves on to asking for the body, remembering the title", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleInstructionTitle(store, client, msg("Возврат чека"));

  assertEquals(await store.getSession(1), { state: "admin_instruction_body", data: { title: "Возврат чека" } });
  assertEquals(sent[0].text.includes("текст инструкции"), true);
});

Deno.test("a body with no trailing URL is saved with no media, and the editor re-opens", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleInstructionBody(store, client, msg("1. Откройте Настройки\n2. Кассовые смены"), "Возврат чека");

  const articles = await store.listInstructions();
  assertEquals(articles[0].title, "Возврат чека");
  assertEquals(articles[0].body, "1. Откройте Настройки\n2. Кассовые смены");
  assertEquals(articles[0].mediaUrl, null);
  assertEquals(sent.some((m) => m.text === "Добавлено ✅"), true);
  assertEquals((await store.getSession(1)).state, null);
});

Deno.test("a body whose last line is a URL saves that line as media, separated from the body text", async () => {
  const store = createInMemoryStore();
  const { client } = fakeTelegram();

  await handleInstructionBody(store, client, msg("Смотрите видео:\nhttps://example.com/v.mp4"), "Аварийная отмена");

  const articles = await store.listInstructions();
  assertEquals(articles[0].body, "Смотрите видео:");
  assertEquals(articles[0].mediaUrl, "https://example.com/v.mp4");
});

Deno.test("an empty body is rejected without creating an article", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleInstructionBody(store, client, msg("   "), "Возврат чека");

  assertEquals((await store.listInstructions()).length, 0);
  assertEquals(sent[0].text.includes("не может быть пустым"), true);
});

Deno.test("handleInstructionsDelete removes the article and edits the keyboard in place", async () => {
  const store = createInMemoryStore();
  const article = await store.addInstruction("Списания", "текст", null);
  const { client, edited } = fakeTelegram();

  await handleInstructionsDelete(store, client, cbq(`admin:instr:del:${article.id}`), article.id);

  assertEquals((await store.listInstructions()).length, 0);
  assertEquals(edited[0].messageId, 9);
});

Deno.test("handleInstructionsDone clears any lingering session", async () => {
  const store = createInMemoryStore();
  await store.setSession(1, "admin_instruction_title", {});
  const { client, answered } = fakeTelegram();

  await handleInstructionsDone(store, client, cbq("admin:instr:done"));

  assertEquals((await store.getSession(1)).state, null);
  assertEquals(answered, [{ id: "cbq", text: "Сохранено." }]);
});
