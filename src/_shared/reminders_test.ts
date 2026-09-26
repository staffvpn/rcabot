import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decideReminders } from "./reminders.ts";
import type { ScheduleDay, Shift } from "./store.ts";

const scheduleDay: ScheduleDay = { weekday: 0, opensAt: "08:30", closesAt: "19:30" };

function baseShift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: "shift-1", employeeId: "emp-1", shiftDate: "2026-09-21",
    openedAt: null, closedAt: null, openCashAmount: null, closingFloatAmount: null, cashDiscrepancy: null,
    xreportCash: null, xreportCashless: null, xreportAt: null, status: "pending",
    remindedOpenAt: null, notifiedLateAt: null, remindedCloseAt: null, remindedXreportAt: null,
    ...overrides,
  };
}

function atVenueTime(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 8, 21, h - 3, m)); // UTC+3 venue offset
}

Deno.test("9 minutes before opening, a still-pending un-reminded shift gets remind_open", () => {
  const actions = decideReminders(atVenueTime("08:21"), scheduleDay, baseShift());
  assertEquals(actions, [{ type: "remind_open", employeeId: "emp-1", shiftId: "shift-1" }]);
});

Deno.test("15 minutes before opening, nothing fires yet", () => {
  const actions = decideReminders(atVenueTime("08:15"), scheduleDay, baseShift());
  assertEquals(actions, []);
});

Deno.test("already reminded, still before opening — remind_open does not fire again", () => {
  const actions = decideReminders(atVenueTime("08:25"), scheduleDay, baseShift({ remindedOpenAt: "2026-09-21T05:21:00.000Z" }));
  assertEquals(actions, []);
});

Deno.test("at or after opening time, a still-pending shift gets notify_late instead of remind_open", () => {
  const actions = decideReminders(atVenueTime("08:30"), scheduleDay, baseShift());
  assertEquals(actions, [{ type: "notify_late", employeeId: "emp-1", shiftId: "shift-1" }]);
});

Deno.test("already notified late — notify_late does not fire again", () => {
  const actions = decideReminders(atVenueTime("09:00"), scheduleDay, baseShift({ notifiedLateAt: "2026-09-21T05:30:00.000Z" }));
  assertEquals(actions, []);
});

Deno.test("an open shift, 5 minutes before closing, un-reminded, gets remind_close", () => {
  // 19:25 is also past the 14:20 X-report time, so isolate remind_close by marking
  // the X-report reminder as already sent — otherwise both would fire (see the
  // "same tick" test below, which covers that combined case on purpose).
  const actions = decideReminders(
    atVenueTime("19:25"),
    scheduleDay,
    baseShift({ status: "open", remindedXreportAt: "2026-09-21T11:20:00.000Z" }),
  );
  assertEquals(actions, [{ type: "remind_close", employeeId: "emp-1", shiftId: "shift-1" }]);
});

Deno.test("an open shift at or after 14:20, un-reminded, gets remind_xreport", () => {
  const actions = decideReminders(atVenueTime("14:20"), scheduleDay, baseShift({ status: "open" }));
  assertEquals(actions, [{ type: "remind_xreport", employeeId: "emp-1", shiftId: "shift-1" }]);
});

Deno.test("an open shift before 14:20 does not get remind_xreport", () => {
  const actions = decideReminders(atVenueTime("14:15"), scheduleDay, baseShift({ status: "open" }));
  assertEquals(actions, []);
});

Deno.test("a closed shift never produces any reminder action", () => {
  const actions = decideReminders(atVenueTime("08:21"), scheduleDay, baseShift({ status: "closed" }));
  assertEquals(actions, []);
});

Deno.test("an open shift can get both remind_close and remind_xreport on the same tick if both are due", () => {
  const lateSchedule: ScheduleDay = { weekday: 0, opensAt: "08:30", closesAt: "14:25" };
  const actions = decideReminders(atVenueTime("14:20"), lateSchedule, baseShift({ status: "open" }));
  assertEquals(actions.map((a) => a.type).sort(), ["remind_close", "remind_xreport"]);
});
