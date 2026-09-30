import type { Employee, ScheduleDay, Shift, Store } from "../_shared/store.ts";
import type { TelegramClient } from "../_shared/telegram.ts";
import { todayDateKey, todayWeekday } from "../_shared/time.ts";
import { notifyAdmins } from "../_shared/notify.ts";
import { decideReminders, type ReminderAction } from "../_shared/reminders.ts";

export async function runCronTick(
  store: Store,
  telegram: TelegramClient,
  now: Date = new Date(),
): Promise<void> {
  const weekday = todayWeekday(now);
  const dateKey = todayDateKey(now);
  const schedule = await store.getSchedule();
  const scheduleDay = schedule.find((d) => d.weekday === weekday);
  if (!scheduleDay) return;

  const assignments = await store.listScheduleAssignmentsForDate(dateKey);
  const employees = await store.listEmployees();
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  for (const assignment of assignments) {
    const employee = employeeById.get(assignment.employeeId);
    if (!employee || !employee.active) continue;

    let shift = await store.getShift(employee.id, dateKey);
    if (!shift) shift = await store.createShift(employee.id, dateKey);
    if (shift.status === "closed") continue;

    // Each assignment's own start/end time, not the venue's general weekday hours — two
    // people scheduled the same day can have different windows (spec 2026-09-30 §5).
    const effectiveSchedule: ScheduleDay = { weekday, opensAt: assignment.startTime, closesAt: assignment.endTime };

    const actions = decideReminders(now, effectiveSchedule, shift);
    for (const action of actions) {
      await applyAction(store, telegram, employee, shift, action, effectiveSchedule);
    }
  }
}

async function applyAction(
  store: Store,
  telegram: TelegramClient,
  employee: Employee,
  shift: Shift,
  action: ReminderAction,
  scheduleDay: ScheduleDay,
): Promise<void> {
  const now = new Date().toISOString();
  switch (action.type) {
    case "remind_open":
      await telegram.sendMessage(
        employee.telegramId,
        `Через 10 минут открытие смены (${scheduleDay.opensAt}). Не забудьте нажать OPEN.`,
      );
      await store.updateShift(shift.id, { remindedOpenAt: now });
      break;
    case "notify_late":
      // Named again: with a real schedule, the bot now knows exactly who was due in.
      await notifyAdmins(
        store,
        telegram,
        `🔴 Опоздание: ${employee.fullName} не открыл(а) смену вовремя (по графику ${scheduleDay.opensAt}).`,
      );
      await store.updateShift(shift.id, { notifiedLateAt: now });
      break;
    case "remind_close":
      await telegram.sendMessage(
        employee.telegramId,
        `Через 10 минут закрытие смены (${scheduleDay.closesAt}). Когда будете готовы — CLOSER.`,
      );
      await store.updateShift(shift.id, { remindedCloseAt: now });
      break;
    case "remind_xreport":
      await telegram.sendMessage(employee.telegramId, "🧾 Время контрольного X-отчёта. Введите сумму в кассе.", {
        replyMarkup: { inline_keyboard: [[{ text: "Ввести отчёт", callback_data: "xreport:start" }]] },
      });
      await store.updateShift(shift.id, { remindedXreportAt: now });
      break;
  }
}
