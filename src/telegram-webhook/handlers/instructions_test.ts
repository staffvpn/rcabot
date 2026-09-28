import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { handleInstructionShow, handleInstructionsMenu } from "./instructions.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const deleted: { chatId: number; messageId: number }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); return { messageId: sent.length }; },
    async sendPhoto() {}, async deleteMessage(chatId, messageId) { deleted.push({ chatId, messageId }); }, async getChatByUsername() { return null; },
    async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };
  return { client, sent, deleted };
}

Deno.test("a stranger (not a registered employee or admin) gets no response from the instructions menu", async () => {
  const store = createInMemoryStore();
  await store.addInstruction("Возврат чека (наличные)", "1. Откройте Настройки...", null);
  const { client, sent } = fakeTelegram();

  await handleInstructionsMenu(store, client, { message_id: 1, from: { id: 999, first_name: "Чужой" }, chat: { id: 999 }, text: "📖 Инструкции" });

  assertEquals(sent, []);
});

Deno.test("the instructions menu tells the employee when nothing has been added yet", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await handleInstructionsMenu(store, client, { message_id: 1, from: { id: 1, first_name: "Анна" }, chat: { id: 1 }, text: "📖 Инструкции" });

  assertEquals(sent, [{ chatId: 1, text: "Инструкции пока не добавлены.", replyMarkup: undefined }]);
});

Deno.test("the instructions menu lists one button per article", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const article = await store.addInstruction("Возврат чека (наличные)", "1. Откройте Настройки...", null);
  const { client, sent } = fakeTelegram();

  await handleInstructionsMenu(store, client, { message_id: 1, from: { id: 1, first_name: "Анна" }, chat: { id: 1 }, text: "📖 Инструкции" });

  assertEquals(sent[0].replyMarkup, {
    inline_keyboard: [[{ text: "Возврат чека (наличные)", callback_data: `instr:show:${article.id}` }]],
  });
});

Deno.test("the instructions menu does not list sub-section articles — only their parent shows at the top level", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const parent = await store.addInstruction("Информация по смене", "Выберите раздел ниже.", null);
  await store.addInstruction("Открытие смены", "1. Откройте Настройки...", null, parent.id);
  const { client, sent } = fakeTelegram();

  await handleInstructionsMenu(store, client, { message_id: 1, from: { id: 1, first_name: "Анна" }, chat: { id: 1 }, text: "📖 Инструкции" });

  assertEquals(sent[0].replyMarkup, {
    inline_keyboard: [[{ text: "Информация по смене", callback_data: `instr:show:${parent.id}` }]],
  });
});

Deno.test("opening a top-level article that has sub-sections shows a submenu instead of its body", async () => {
  const store = createInMemoryStore();
  const parent = await store.addInstruction("Информация по смене", "Выберите раздел ниже.", null);
  const child1 = await store.addInstruction("Открытие смены", "1. Откройте Настройки...", null, parent.id);
  const child2 = await store.addInstruction("Инкассация", "1. Настройки → Кассовые смены...", null, parent.id);
  const { client, sent } = fakeTelegram();
  const cbq: TelegramCallbackQuery = { id: "cbq", from: { id: 1, first_name: "Анна" }, message: { chat: { id: 1 }, message_id: 5 }, data: `instr:show:${parent.id}` };

  await handleInstructionShow(store, client, cbq, parent.id);

  assertEquals(sent, [{
    chatId: 1,
    text: "Выберите раздел:",
    replyMarkup: { inline_keyboard: [
      [{ text: "Открытие смены", callback_data: `instr:show:${child1.id}` }],
      [{ text: "Инкассация", callback_data: `instr:show:${child2.id}` }],
    ] },
  }]);
});

Deno.test("opening a sub-section article shows its own body, same as any leaf article", async () => {
  const store = createInMemoryStore();
  const parent = await store.addInstruction("Информация по смене", "Выберите раздел ниже.", null);
  const child = await store.addInstruction("Открытие смены", "1. Откройте Настройки...", null, parent.id);
  const { client, sent } = fakeTelegram();
  const cbq: TelegramCallbackQuery = { id: "cbq", from: { id: 1, first_name: "Анна" }, message: { chat: { id: 1 }, message_id: 5 }, data: `instr:show:${child.id}` };

  await handleInstructionShow(store, client, cbq, child.id);

  assertEquals(sent, [{ chatId: 1, text: "ОТКРЫТИЕ СМЕНЫ\n1. Откройте Настройки...", replyMarkup: undefined }]);
});

Deno.test("navigating menu → submenu → article deletes the previous step's message each time", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const parent = await store.addInstruction("Информация по смене", "Выберите раздел ниже.", null);
  const child = await store.addInstruction("Открытие смены", "1. Откройте Настройки...", null, parent.id);
  const { client, deleted } = fakeTelegram();

  await handleInstructionsMenu(store, client, { message_id: 1, from: { id: 1, first_name: "Анна" }, chat: { id: 1 }, text: "📖 Инструкции" });
  const cbq1: TelegramCallbackQuery = { id: "cbq1", from: { id: 1, first_name: "Анна" }, message: { chat: { id: 1 }, message_id: 5 }, data: `instr:show:${parent.id}` };
  await handleInstructionShow(store, client, cbq1, parent.id);
  const cbq2: TelegramCallbackQuery = { id: "cbq2", from: { id: 1, first_name: "Анна" }, message: { chat: { id: 1 }, message_id: 5 }, data: `instr:show:${child.id}` };
  await handleInstructionShow(store, client, cbq2, child.id);

  assertEquals(deleted, [{ chatId: 1, messageId: 1 }, { chatId: 1, messageId: 2 }]);
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
