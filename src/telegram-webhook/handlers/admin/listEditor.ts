import type { Store } from "../../../_shared/store.ts";
import type { InlineKeyboard, TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";

export interface ListEditorRow {
  id: string;
  label: string;
}

export interface ListEditorConfig {
  key: string;
  promptText: string;
  listRows(store: Store): Promise<ListEditorRow[]>;
  addFromText(store: Store, text: string): Promise<{ ok: true } | { ok: false; error: string }>;
  remove(store: Store, id: string): Promise<void>;
}

export function renderListEditorKeyboard(key: string, rows: ListEditorRow[]): InlineKeyboard {
  const itemRows = rows.map((r) => [
    { text: r.label, callback_data: "noop" },
    { text: "🗑", callback_data: `admin:list:${key}:del:${r.id}` },
  ]);
  return { inline_keyboard: [...itemRows, [{ text: "✅ Готово", callback_data: `admin:list:${key}:done` }]] };
}

export async function openListEditor(
  store: Store,
  telegram: TelegramClient,
  chatId: number,
  telegramId: number,
  config: ListEditorConfig,
): Promise<void> {
  await store.setSession(telegramId, "admin_list_add", { key: config.key });
  const rows = await config.listRows(store);
  await telegram.sendMessage(chatId, config.promptText, { replyMarkup: renderListEditorKeyboard(config.key, rows) });
}

export async function handleListEditorAddText(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
  config: ListEditorConfig,
): Promise<void> {
  const result = await config.addFromText(store, message.text ?? "");
  if (!result.ok) {
    await telegram.sendMessage(message.chat.id, result.error);
    return;
  }
  const rows = await config.listRows(store);
  await telegram.sendMessage(message.chat.id, "Добавлено ✅", { replyMarkup: renderListEditorKeyboard(config.key, rows) });
}

export async function handleListEditorDelete(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  config: ListEditorConfig,
  id: string,
): Promise<void> {
  await config.remove(store, id);
  const rows = await config.listRows(store);
  await telegram.editMessageReplyMarkup(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    renderListEditorKeyboard(config.key, rows),
  );
  await telegram.answerCallbackQuery(callbackQuery.id);
}

export async function handleListEditorDone(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  await store.clearSession(callbackQuery.from.id);
  await telegram.answerCallbackQuery(callbackQuery.id, "Сохранено.");
}
