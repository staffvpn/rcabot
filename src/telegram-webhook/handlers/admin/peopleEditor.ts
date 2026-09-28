import type { Store } from "../../../_shared/store.ts";
import type { InlineKeyboard, TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";
import { clearEphemeral, sendEphemeral } from "../../ephemeral.ts";

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
  telegramId: number,
  config: PeopleEditorConfig,
): Promise<void> {
  const rows = await config.listRows(store);
  await sendEphemeral(store, telegram, telegramId, chatId, config.promptText, {
    replyMarkup: renderPeopleKeyboard(config.key, rows),
  });
}

export async function handlePeopleAddStart(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  config: PeopleEditorConfig,
): Promise<void> {
  await store.setSession(callbackQuery.from.id, "admin_people_add", { key: config.key });
  await telegram.answerCallbackQuery(callbackQuery.id);
  await sendEphemeral(
    store, telegram, callbackQuery.from.id, callbackQuery.message.chat.id,
    "Если человек уже писал этому боту — пришлите его @username. Если нет — попросите сначала написать боту /start, а затем пришлите @username или перешлите сюда любое его сообщение.",
  );
}

export async function handlePeopleForward(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
  config: PeopleEditorConfig,
): Promise<void> {
  if (message.forward_origin?.type === "hidden_user") {
    await sendEphemeral(
      store, telegram, message.from.id, message.chat.id,
      "У этого человека скрыт отправитель при пересылке — Telegram не передаёт его ID. Попросите его открыть Настройки → Конфиденциальность → Пересылка сообщений, разрешить показ отправителя и переслать сообщение ещё раз.",
    );
    return;
  }

  const forwarded = extractForwardedUser(message);
  const text = (message.text ?? "").trim();

  let resolved = forwarded;
  if (!resolved && text.startsWith("@")) {
    resolved = await telegram.getChatByUsername(text);
    if (!resolved) {
      await sendEphemeral(
        store, telegram, message.from.id, message.chat.id,
        "Не нашёл этого пользователя — скорее всего, он ни разу не писал боту. Попросите его сначала отправить боту /start, затем пришлите @username ещё раз (или перешлите сюда любое его сообщение).",
      );
      return;
    }
  }

  if (!resolved) {
    await sendEphemeral(
      store, telegram, message.from.id, message.chat.id,
      "Это не похоже на пересланное сообщение или @username. Перешлите сюда сообщение от нужного человека либо пришлите его @username.",
    );
    return;
  }

  await config.add(store, resolved.telegramId, resolved.fullName);
  await store.clearSession(message.from.id);

  // One message, not two — sendEphemeral would otherwise delete the confirmation the instant
  // the re-opened editor is sent right after it, so the admin would never see it.
  const rows = await config.listRows(store);
  await sendEphemeral(store, telegram, message.from.id, message.chat.id, `Добавлен(а) ✅ ${resolved.fullName}`, {
    replyMarkup: renderPeopleKeyboard(config.key, rows),
  });
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
  await clearEphemeral(store, telegram, callbackQuery.from.id);
  await telegram.answerCallbackQuery(callbackQuery.id, "Сохранено.");
}

export const employeesConfig: PeopleEditorConfig = {
  key: "employees",
  promptText: "Сотрудники. Нажмите 🗑, чтобы удалить, «➕ Добавить» — чтобы подключить нового.",
  async listRows(store) {
    // removeEmployee soft-deletes (shift history keeps the FK alive) — the editor must still
    // hide inactive rows, or "deleting" someone would look like it did nothing.
    return (await store.listEmployees()).filter((e) => e.active).map((e) => ({ id: e.id, label: e.fullName }));
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
