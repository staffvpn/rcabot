import type { Store } from "../../../_shared/store.ts";
import type { InlineKeyboard, TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";
import { clearEphemeral, sendEphemeral } from "../../ephemeral.ts";

function renderInstructionsKeyboard(rows: { id: string; title: string }[]): InlineKeyboard {
  const itemRows = rows.map((r) => [
    { text: r.title, callback_data: "noop" },
    { text: "🗑", callback_data: `admin:instr:del:${r.id}` },
  ]);
  return {
    inline_keyboard: [
      ...itemRows,
      [{ text: "➕ Добавить", callback_data: "admin:instr:add" }],
      [{ text: "✅ Готово", callback_data: "admin:instr:done" }],
    ],
  };
}

export async function openInstructionsEditor(
  store: Store,
  telegram: TelegramClient,
  chatId: number,
  telegramId: number,
): Promise<void> {
  // Sub-sections (parentId set) aren't manageable here — this flat editor has no notion of
  // nesting, so they stay hidden to avoid confusing the admin with rows it can't organize.
  const articles = (await store.listInstructions()).filter((a) => a.parentId === null);
  await sendEphemeral(store, telegram, telegramId, chatId, "Разделы инструкций:", {
    replyMarkup: renderInstructionsKeyboard(articles.map((a) => ({ id: a.id, title: a.title }))),
  });
}

export async function handleInstructionsAddStart(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  await store.setSession(callbackQuery.from.id, "admin_instruction_title", {});
  await telegram.answerCallbackQuery(callbackQuery.id);
  await sendEphemeral(store, telegram, callbackQuery.from.id, callbackQuery.message.chat.id, "Введите заголовок нового раздела:");
}

export async function handleInstructionTitle(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const title = (message.text ?? "").trim();
  if (!title) {
    await sendEphemeral(store, telegram, message.from.id, message.chat.id, "Заголовок не может быть пустым. Введите текст.");
    return;
  }
  await store.setSession(message.from.id, "admin_instruction_body", { title });
  await sendEphemeral(
    store, telegram, message.from.id, message.chat.id,
    "Введите текст инструкции. Если нужно приложить видео/ссылку, добавьте её последней строкой.",
  );
}

function extractMedia(rawBody: string): { body: string; mediaUrl: string | null } {
  const lines = rawBody.split("\n");
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (/^https?:\/\//i.test(last)) {
    return { body: lines.slice(0, -1).join("\n").trim(), mediaUrl: last };
  }
  return { body: rawBody.trim(), mediaUrl: null };
}

export async function handleInstructionBody(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
  title: string,
): Promise<void> {
  const raw = message.text ?? "";
  if (!raw.trim()) {
    await sendEphemeral(store, telegram, message.from.id, message.chat.id, "Текст не может быть пустым. Введите текст инструкции.");
    return;
  }
  const { body, mediaUrl } = extractMedia(raw);
  await store.addInstruction(title, body, mediaUrl);
  await store.clearSession(message.from.id);

  // One message, not two — sendEphemeral would otherwise delete the confirmation the instant
  // the re-opened editor is sent right after it, so the admin would never see it.
  const articles = (await store.listInstructions()).filter((a) => a.parentId === null);
  await sendEphemeral(store, telegram, message.from.id, message.chat.id, "Добавлено ✅", {
    replyMarkup: renderInstructionsKeyboard(articles.map((a) => ({ id: a.id, title: a.title }))),
  });
}

export async function handleInstructionsDelete(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  id: string,
): Promise<void> {
  await store.removeInstruction(id);
  const articles = (await store.listInstructions()).filter((a) => a.parentId === null);
  await telegram.editMessageReplyMarkup(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    renderInstructionsKeyboard(articles.map((a) => ({ id: a.id, title: a.title }))),
  );
  await telegram.answerCallbackQuery(callbackQuery.id);
}

export async function handleInstructionsDone(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  await store.clearSession(callbackQuery.from.id);
  await clearEphemeral(store, telegram, callbackQuery.from.id);
  await telegram.answerCallbackQuery(callbackQuery.id, "Сохранено.");
}
