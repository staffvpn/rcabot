import type { InstructionArticle, Store } from "../../_shared/store.ts";
import type { InlineKeyboard, TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";

function renderInstructionsKeyboard(articles: InstructionArticle[]): InlineKeyboard {
  return { inline_keyboard: articles.map((a) => [{ text: a.title, callback_data: `instr:show:${a.id}` }]) };
}

export async function handleInstructionsMenu(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(message.from.id);
  const admin = employee ? null : await store.getAdminByTelegramId(message.from.id);
  if (!employee && !admin) return;

  const topLevel = (await store.listInstructions()).filter((a) => a.parentId === null);
  if (topLevel.length === 0) {
    await telegram.sendMessage(message.chat.id, "Инструкции пока не добавлены.");
    return;
  }
  await telegram.sendMessage(message.chat.id, "Выберите раздел:", {
    replyMarkup: renderInstructionsKeyboard(topLevel),
  });
}

export async function handleInstructionShow(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  id: string,
): Promise<void> {
  await telegram.answerCallbackQuery(callbackQuery.id);
  const articles = await store.listInstructions();
  const article = articles.find((a) => a.id === id);
  if (!article) {
    await telegram.sendMessage(callbackQuery.message.chat.id, "Раздел не найден — возможно, его удалили.");
    return;
  }

  const children = articles.filter((a) => a.parentId === id).sort((a, b) => a.position - b.position);
  if (children.length > 0) {
    await telegram.sendMessage(callbackQuery.message.chat.id, "Выберите раздел:", {
      replyMarkup: renderInstructionsKeyboard(children),
    });
    return;
  }

  const text = article.mediaUrl
    ? `${article.title.toUpperCase()}\n${article.body}\n\n🎥 Видео: ${article.mediaUrl}`
    : `${article.title.toUpperCase()}\n${article.body}`;
  await telegram.sendMessage(callbackQuery.message.chat.id, text);
}
