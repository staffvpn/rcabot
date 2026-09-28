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
  const origin = message.forward_origin;
  if (origin?.type === "user") {
    return { telegramId: origin.sender_user.id, fullName: origin.sender_user.first_name };
  }
  // forward_from is deprecated (replaced by forward_origin in Bot API 7.0) but kept as a fallback.
  if (message.forward_from) {
    return { telegramId: message.forward_from.id, fullName: message.forward_from.first_name };
  }
  return null;
}

function renderPeopleKeyboard(key: string, rows: PeopleRow[]): InlineKeyboard {
  // The row's position (not its id) goes in callback_data: Telegram caps callback_data at 64 bytes,
  // and `admin:people:${key}:del:${uuid}` can exceed that for longer keys. handlePeopleDelete
  // resolves the index back against a freshly-read list.
  const itemRows = rows.map((r, index) => [
    { text: r.label, callback_data: "noop" },
    { text: "🗑", callback_data: `admin:people:${key}:del:${index}` },
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
  if (message.forward_origin?.type === "hidden_user") {
    await telegram.sendMessage(
      message.chat.id,
      "У этого человека скрыт отправитель при пересылке — Telegram не передаёт его ID. Попросите его открыть Настройки → Конфиденциальность → Пересылка сообщений, разрешить показ отправителя и переслать сообщение ещё раз.",
    );
    return;
  }

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
  indexStr: string,
): Promise<void> {
  const before = await config.listRows(store);
  const target = before[Number(indexStr)];
  if (!target) {
    await telegram.answerCallbackQuery(callbackQuery.id);
    return;
  }

  try {
    await config.remove(store, target.id);
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
