import type { ScheduleAssignment, Store } from "../../../_shared/store.ts";
import type { InlineKeyboard, TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";
import { todayDateKey } from "../../../_shared/time.ts";
import { clearEphemeral, sendEphemeral } from "../../ephemeral.ts";
import { parseScheduleDate, parseScheduleTime } from "./scheduleParsing.ts";

const UPCOMING_WINDOW_DAYS = 14;

function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function formatDateKeyShort(dateKey: string): string {
  const [, m, d] = dateKey.split("-");
  return `${d}.${m}`;
}

interface ScheduleRow {
  assignment: ScheduleAssignment;
  label: string;
}

async function listUpcomingRows(store: Store, now: Date = new Date()): Promise<ScheduleRow[]> {
  const from = todayDateKey(now);
  const to = addDaysToDateKey(from, UPCOMING_WINDOW_DAYS);
  const assignments = await store.listScheduleAssignmentsBetween(from, to);
  const employees = await store.listEmployees();
  const nameById = new Map(employees.map((e) => [e.id, e.fullName]));
  return assignments.map((a) => ({
    assignment: a,
    label: `${formatDateKeyShort(a.shiftDate)} ${nameById.get(a.employeeId) ?? "?"} ${a.startTime}-${a.endTime}`,
  }));
}

function renderScheduleKeyboard(rows: ScheduleRow[]): InlineKeyboard {
  // Row position (not id) in callback_data, same reasoning as the other admin list editors:
  // stays well under Telegram's 64-byte callback_data cap regardless of id length.
  const itemRows = rows.map((r, index) => [
    { text: r.label, callback_data: "noop" },
    { text: "🗑", callback_data: `admin:schedule:del:${index}` },
  ]);
  return {
    inline_keyboard: [
      ...itemRows,
      [{ text: "➕ Добавить", callback_data: "admin:schedule:add" }],
      [{ text: "✅ Готово", callback_data: "admin:schedule:done" }],
    ],
  };
}

export async function openScheduleEditor(
  store: Store,
  telegram: TelegramClient,
  chatId: number,
  telegramId: number,
): Promise<void> {
  const rows = await listUpcomingRows(store);
  await sendEphemeral(store, telegram, telegramId, chatId, "Ближайший график:", {
    replyMarkup: renderScheduleKeyboard(rows),
  });
}

export async function handleScheduleAddStart(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  await store.setSession(callbackQuery.from.id, "admin_schedule_date", {});
  await telegram.answerCallbackQuery(callbackQuery.id);
  await sendEphemeral(store, telegram, callbackQuery.from.id, callbackQuery.message.chat.id, "Введите дату (например, 30.09):");
}

export async function handleScheduleDateText(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const parsed = parseScheduleDate(message.text ?? "");
  if (!parsed) {
    await sendEphemeral(store, telegram, message.from.id, message.chat.id, "Не понял дату. Формат: 30.09.");
    return;
  }
  const employees = (await store.listEmployees()).filter((e) => e.active);
  await store.setSession(message.from.id, "admin_schedule_employee", { date: parsed });
  await sendEphemeral(store, telegram, message.from.id, message.chat.id, "Кто работает?", {
    replyMarkup: { inline_keyboard: employees.map((e, index) => [{ text: e.fullName, callback_data: `admin:schedule:pick:${index}` }]) },
  });
}

export async function handleSchedulePick(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  indexStr: string,
): Promise<void> {
  const employees = (await store.listEmployees()).filter((e) => e.active);
  const employee = employees[Number(indexStr)];
  if (!employee) {
    await telegram.answerCallbackQuery(callbackQuery.id);
    return;
  }
  const session = await store.getSession(callbackQuery.from.id);
  const date = session.data.date as string;
  await store.setSession(callbackQuery.from.id, "admin_schedule_time", { date, employeeId: employee.id });
  await telegram.answerCallbackQuery(callbackQuery.id);
  await sendEphemeral(store, telegram, callbackQuery.from.id, callbackQuery.message.chat.id, "Введите время (например, 08:30-14:30):");
}

export async function handleScheduleTimeText(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const parsed = parseScheduleTime(message.text ?? "");
  if (!parsed) {
    await sendEphemeral(store, telegram, message.from.id, message.chat.id, "Не понял время. Формат: 08:30-14:30.");
    return;
  }
  const session = await store.getSession(message.from.id);
  const date = session.data.date as string;
  const employeeId = session.data.employeeId as string;
  await store.upsertScheduleAssignment(employeeId, date, parsed.startTime, parsed.endTime);
  await store.clearSession(message.from.id);
  await openScheduleEditor(store, telegram, message.chat.id, message.from.id);
}

export async function handleScheduleDelete(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  indexStr: string,
): Promise<void> {
  const rows = await listUpcomingRows(store);
  const target = rows[Number(indexStr)];
  if (!target) {
    await telegram.answerCallbackQuery(callbackQuery.id);
    return;
  }
  await store.removeScheduleAssignment(target.assignment.id);
  const remaining = await listUpcomingRows(store);
  await telegram.editMessageReplyMarkup(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    renderScheduleKeyboard(remaining),
  );
  await telegram.answerCallbackQuery(callbackQuery.id);
}

export async function handleScheduleDone(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  await store.clearSession(callbackQuery.from.id);
  await clearEphemeral(store, telegram, callbackQuery.from.id);
  await telegram.answerCallbackQuery(callbackQuery.id, "Сохранено.");
}
