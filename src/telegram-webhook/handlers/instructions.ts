import type { Store } from "../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";

export async function handleInstructionsMenu(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const articles = await store.listInstructions();
  if (articles.length === 0) {
    await telegram.sendMessage(message.chat.id, "Инструкции пока не добавлены.");
    return;
  }
  await telegram.sendMessage(message.chat.id, "Выберите раздел:", {
    replyMarkup: { inline_keyboard: articles.map((a) => [{ text: a.title, callback_data: `instr:show:${a.id}` }]) },
  });
}

export async function handleInstructionShow(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  id: string,
): Promise<void> {
  await telegram.answerCallbackQuery(callbackQuery.id);
  const article = (await store.listInstructions()).find((a) => a.id === id);
  if (!article) {
    await telegram.sendMessage(callbackQuery.message.chat.id, "Раздел не найден — возможно, его удалили.");
    return;
  }
  const text = article.mediaUrl
    ? `${article.title.toUpperCase()}\n${article.body}\n\n🎥 Видео: ${article.mediaUrl}`
    : `${article.title.toUpperCase()}\n${article.body}`;
  await telegram.sendMessage(callbackQuery.message.chat.id, text);
}
