import type { Store } from "../../../_shared/store.ts";
import type { InlineKeyboard, TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";

export interface PeopleRow {
  id: string;
  label: string;
}

export interface PeopleEditorConfig {
  key: string;
  promptText: string;
  listRows(store: Store): Promise<PeopleRow[]>;
  add(store: Store, telegramId: number, fullName: string): Promise<void>;
  remove(store: Store, id: string): Promise<void>;
}

export function extractForwardedUser(message: TelegramMessage): { telegramId: number; fullName: string } | null {
  if (!message.forward_from) return null;
  return { telegramId: message.forward_from.id, fullName: message.forward_from.first_name };
}

function renderPeopleKeyboard(key: string, rows: PeopleRow[]): InlineKeyboard {
  const itemRows = rows.map((r) => [
    { text: r.label, callback_data: "noop" },
    { text: "🗑", callback_data: `admin:people:${key}:del:${r.id}` },
  ]);
  return {
    inline_keyboard: [
      ...itemRows,
      [{ text: "➕ Добавить", callback_data: `admin:people:${key}:add` }],
      [{ text: "✅ Готово", callback_data: `admin:people:${key}:done` }],
    ],
  };
}

export async function openPeopleEditor(
  store: Store,
  telegram: TelegramClient,
  chatId: number,
  config: PeopleEditorConfig,
): Promise<void> {
  const rows = await config.listRows(store);
  await telegram.sendMessage(chatId, config.promptText, { replyMarkup: renderPeopleKeyboard(config.key, rows) });
}

export async function handlePeopleAddStart(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  config: PeopleEditorConfig,
): Promise<void> {
  await store.setSession(callbackQuery.from.id, "admin_people_add", { key: config.key });
  await telegram.answerCallbackQuery(callbackQuery.id);
  await telegram.sendMessage(
    callbackQuery.message.chat.id,
    "Попросите нового человека написать боту /start, затем перешлите сюда любое его сообщение — бот возьмёт из него Telegram.",
  );
}

export async function handlePeopleForward(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
  config: PeopleEditorConfig,
): Promise<void> {
  const forwarded = extractForwardedUser(message);
  if (!forwarded) {
    await telegram.sendMessage(message.chat.id, "Это не похоже на пересланное сообщение. Перешлите сюда сообщение от нужного человека.");
    return;
  }

  await config.add(store, forwarded.telegramId, forwarded.fullName);
  await store.clearSession(message.from.id);

  await telegram.sendMessage(message.chat.id, `Добавлен(а) ✅ ${forwarded.fullName}`);
  await openPeopleEditor(store, telegram, message.chat.id, config);
}

export async function handlePeopleDelete(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  config: PeopleEditorConfig,
  id: string,
): Promise<void> {
  try {
    await config.remove(store, id);
  } catch (err) {
    await telegram.answerCallbackQuery(callbackQuery.id, err instanceof Error ? err.message : "Не удалось удалить.");
    return;
  }

  const rows = await config.listRows(store);
  await telegram.editMessageReplyMarkup(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    renderPeopleKeyboard(config.key, rows),
  );
  await telegram.answerCallbackQuery(callbackQuery.id);
}

export async function handlePeopleDone(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  await store.clearSession(callbackQuery.from.id);
  await telegram.answerCallbackQuery(callbackQuery.id, "Сохранено.");
}

export const employeesConfig: PeopleEditorConfig = {
  key: "employees",
  promptText: "Сотрудники. Нажмите 🗑, чтобы удалить, «➕ Добавить» — чтобы подключить нового.",
  async listRows(store) {
    return (await store.listEmployees()).map((e) => ({ id: e.id, label: e.fullName }));
  },
  async add(store, telegramId, fullName) {
    await store.addEmployee(telegramId, fullName);
  },
  async remove(store, id) {
    await store.removeEmployee(id);
  },
};

export const adminsConfig: PeopleEditorConfig = {
  key: "admins",
  promptText: "Администраторы. Нажмите 🗑, чтобы удалить, «➕ Добавить» — чтобы подключить нового.",
  async listRows(store) {
    return (await store.listAdmins()).map((a) => ({ id: a.id, label: a.fullName }));
  },
  async add(store, telegramId, fullName) {
    await store.addAdmin(telegramId, fullName);
  },
  async remove(store, id) {
    await store.removeAdmin(id); // throws "Cannot remove the last remaining admin" — handlePeopleDelete surfaces it
  },
};

export const PEOPLE_EDITOR_CONFIGS: Record<string, PeopleEditorConfig> = {
  employees: employeesConfig,
  admins: adminsConfig,
};
