import type { ScheduleDay, Shift } from "./store.ts";
import { VENUE_TZ_OFFSET_MINUTES } from "./time.ts";

export const XREPORT_TIME = "14:20";
const REMINDER_LEAD_MINUTES = 10;

export type ReminderActionType = "remind_open" | "notify_late" | "remind_close" | "remind_xreport";

export interface ReminderAction {
  type: ReminderActionType;
  employeeId: string;
  shiftId: string;
}

function minutesUntil(now: Date, hhmm: string): number {
  const shifted = new Date(now.getTime() + VENUE_TZ_OFFSET_MINUTES * 60_000);
  const [h, m] = hhmm.split(":").map(Number);
  const targetMinutes = h * 60 + m;
  const nowMinutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return targetMinutes - nowMinutes;
}

export function decideReminders(now: Date, scheduleDay: ScheduleDay, shift: Shift): ReminderAction[] {
  const actions: ReminderAction[] = [];
  if (shift.status === "closed") return actions;

  if (shift.status === "pending") {
    const minutesUntilOpen = minutesUntil(now, scheduleDay.opensAt);
    if (minutesUntilOpen > 0 && minutesUntilOpen <= REMINDER_LEAD_MINUTES && !shift.remindedOpenAt) {
      actions.push({ type: "remind_open", employeeId: shift.employeeId, shiftId: shift.id });
    }
    if (minutesUntilOpen <= 0 && !shift.notifiedLateAt) {
      actions.push({ type: "notify_late", employeeId: shift.employeeId, shiftId: shift.id });
    }
  }

  if (shift.status === "open") {
    const minutesUntilClose = minutesUntil(now, scheduleDay.closesAt);
    if (minutesUntilClose > 0 && minutesUntilClose <= REMINDER_LEAD_MINUTES && !shift.remindedCloseAt) {
      actions.push({ type: "remind_close", employeeId: shift.employeeId, shiftId: shift.id });
    }
    if (minutesUntil(now, XREPORT_TIME) <= 0 && !shift.remindedXreportAt) {
      actions.push({ type: "remind_xreport", employeeId: shift.employeeId, shiftId: shift.id });
    }
  }

  return actions;
}
