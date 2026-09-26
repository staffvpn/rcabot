import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { handleInstructionShow, handleInstructionsMenu } from "./instructions.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); },
    async sendPhoto() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };
  return { client, sent };
}

Deno.test("the instructions menu tells the employee when nothing has been added yet", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleInstructionsMenu(store, client, { message_id: 1, from: { id: 1, first_name: "Анна" }, chat: { id: 1 }, text: "📖 Инструкции" });

  assertEquals(sent, [{ chatId: 1, text: "Инструкции пока не добавлены.", replyMarkup: undefined }]);
});

Deno.test("the instructions menu lists one button per article", async () => {
  const store = createInMemoryStore();
  const article = await store.addInstruction("Возврат чека (наличные)", "1. Откройте Настройки...", null);
  const { client, sent } = fakeTelegram();

  await handleInstructionsMenu(store, client, { message_id: 1, from: { id: 1, first_name: "Анна" }, chat: { id: 1 }, text: "📖 Инструкции" });

  assertEquals(sent[0].replyMarkup, {
    inline_keyboard: [[{ text: "Возврат чека (наличные)", callback_data: `instr:show:${article.id}` }]],
  });
});

Deno.test("showing an article with no media prints just the title and body", async () => {
  const store = createInMemoryStore();
  const article = await store.addInstruction("Списания", "Причины списания...", null);
  const { client, sent } = fakeTelegram();
  const cbq: TelegramCallbackQuery = { id: "cbq", from: { id: 1, first_name: "Анна" }, message: { chat: { id: 1 }, message_id: 5 }, data: `instr:show:${article.id}` };

  await handleInstructionShow(store, client, cbq, article.id);

  assertEquals(sent, [{ chatId: 1, text: "СПИСАНИЯ\nПричины списания...", replyMarkup: undefined }]);
});

Deno.test("showing an article with media appends the video/link line", async () => {
  const store = createInMemoryStore();
  const article = await store.addInstruction("Аварийная отмена", "1. Аварийная отмена...", "https://example.com/video.mp4");
  const { client, sent } = fakeTelegram();
  const cbq: TelegramCallbackQuery = { id: "cbq", from: { id: 1, first_name: "Анна" }, message: { chat: { id: 1 }, message_id: 5 }, data: `instr:show:${article.id}` };

  await handleInstructionShow(store, client, cbq, article.id);

  assertEquals(sent[0].text.includes("🎥 Видео: https://example.com/video.mp4"), true);
});

Deno.test("showing a deleted/unknown article id fails gracefully instead of crashing", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();
  const cbq: TelegramCallbackQuery = { id: "cbq", from: { id: 1, first_name: "Анна" }, message: { chat: { id: 1 }, message_id: 5 }, data: "instr:show:missing" };

  await handleInstructionShow(store, client, cbq, "missing");

  assertEquals(sent, [{ chatId: 1, text: "Раздел не найден — возможно, его удалили.", replyMarkup: undefined }]);
});
