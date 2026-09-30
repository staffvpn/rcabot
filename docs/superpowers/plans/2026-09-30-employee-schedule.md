# Employee Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins assign employees to specific dates/times in the bot itself, and retarget the cron's reminders and lateness checks to only the people actually scheduled that day — instead of every registered employee.

**Architecture:** One new table (`schedule_assignments`: employee + date + start/end time) behind four new `Store` methods. `cron-tick/run.ts` switches from iterating all active employees to iterating today's assignments, building a per-assignment `{opensAt, closesAt}` pair it hands to the existing `decideReminders` unchanged. A new `/admin → 📅 График` editor (list + add + delete + done, matching the existing checklist/instructions/people editors) lets admins manage assignments via a three-step add flow: date (text) → employee (inline keyboard) → time (text).

**Tech Stack:** TypeScript, Deno test, Cloudflare Workers + D1 (SQLite), Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-09-30-employee-schedule-design.md`

## Global Constraints

- One `schedule_assignments` row per (employee, date) — adding a second replaces the first (upsert), never duplicates. No DB-level unique constraint (app-level only, per spec §3).
- Schedule never blocks OPEN/CLOSER — it only targets reminders/lateness checks (spec §2, §5).
- The venue-wide `schedule` table (weekday → opensAt/closesAt) is untouched — still used for the `!scheduleDay` business-day guard and the 14:20 X-report cutoff (spec §6). Do not remove or restructure it.
- Lateness notices name the specific employee again: `🔴 Опоздание: {ФИО} не открыл(а) смену вовремя (по графику {start}).` (spec §7) — this reverses the nameless wording shipped 2026-09-30.
- The per-tick "only one lateness notice total" dedup (`lateAlreadyNotifiedThisTick` in the current `run.ts`) is removed entirely — two different scheduled people who are both late are two different events, both must reach admins (spec §5).
- All Russian user-facing strings match the spec's wording exactly where the spec gives exact wording (§4, §7).

## Review Focus

- Two employees scheduled the same day with different times, both late: must produce two separate admin notices, not deduped into one (spec §5 explicitly reverses the old I1 dedup for this case).
- A scheduled employee who is soft-deleted (`active: false`) after being scheduled must still be skipped by the cron, same as today's inactive-employee handling.
- Typing an unparseable date or time mid-add-flow must re-prompt with the format example and keep the session alive — not drop back to the main menu or crash.
- The 14-day upcoming-list window boundary: an assignment exactly 14 days from today must not silently vanish or silently appear depending on an off-by-one — pin the boundary with a test.
- Deleting a schedule assignment must never touch an already-created `shifts` row for that date — shift history (and any already-recorded open/close) survives even after its assignment is removed.

---

### Task 1: `ScheduleAssignment` in the Store (in-memory + D1) + migration

**Files:**
- Modify: `src/_shared/store.ts` (add type, interface methods, in-memory impl)
- Modify: `src/_shared/store_test.ts` (add tests)
- Modify: `src/_shared/d1Store.ts` (add D1 impl)
- Create: `migrations/0006_add_schedule_assignments.sql`

**Interfaces:**
- Produces: `ScheduleAssignment { id: string; employeeId: string; shiftDate: string; startTime: string; endTime: string }`; `Store.listScheduleAssignmentsForDate(shiftDate: string): Promise<ScheduleAssignment[]>`; `Store.listScheduleAssignmentsBetween(fromDateInclusive: string, toDateExclusive: string): Promise<ScheduleAssignment[]>` (sorted by `shiftDate` ascending); `Store.upsertScheduleAssignment(employeeId: string, shiftDate: string, startTime: string, endTime: string): Promise<ScheduleAssignment>`; `Store.removeScheduleAssignment(id: string): Promise<void>`.

- [ ] **Step 1: Write the failing store tests**

Add to `src/_shared/store_test.ts` (near the other CRUD round-trip tests):

```ts
Deno.test("upsertScheduleAssignment creates, then replaces (not duplicates) the same employee+date", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");

  const first = await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  assertEquals(first.startTime, "08:30");

  const second = await store.upsertScheduleAssignment(employee.id, "2026-09-30", "09:00", "15:00");
  assertEquals(second.id, first.id);
  assertEquals(second.startTime, "09:00");
  assertEquals(second.endTime, "15:00");

  const forDate = await store.listScheduleAssignmentsForDate("2026-09-30");
  assertEquals(forDate.length, 1);
});

Deno.test("listScheduleAssignmentsForDate only returns rows for that exact date", async () => {
  const store = createInMemoryStore();
  const anna = await store.addEmployee(1, "Анна");
  const ivan = await store.addEmployee(2, "Иван");
  await store.upsertScheduleAssignment(anna.id, "2026-09-30", "08:30", "14:30");
  await store.upsertScheduleAssignment(ivan.id, "2026-10-01", "08:30", "19:30");

  const rows = await store.listScheduleAssignmentsForDate("2026-09-30");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].employeeId, anna.id);
});

Deno.test("listScheduleAssignmentsBetween is [from, to) — includes the start date, excludes the end date, sorted by date", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-29", "08:30", "14:30"); // before window
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30"); // window start (included)
  await store.upsertScheduleAssignment(employee.id, "2026-10-05", "08:30", "14:30"); // window end minus 1 (included)
  await store.upsertScheduleAssignment(employee.id, "2026-10-06", "08:30", "14:30"); // window end (excluded)

  const rows = await store.listScheduleAssignmentsBetween("2026-09-30", "2026-10-06");

  assertEquals(rows.map((r) => r.shiftDate), ["2026-09-30", "2026-10-05"]);
});

Deno.test("removeScheduleAssignment deletes the row; other assignments are untouched", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const keep = await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  const gone = await store.upsertScheduleAssignment(employee.id, "2026-10-01", "08:30", "14:30");

  await store.removeScheduleAssignment(gone.id);

  const rows = await store.listScheduleAssignmentsBetween("2026-09-01", "2026-11-01");
  assertEquals(rows.map((r) => r.id), [keep.id]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/projects/smena-bot && deno test src/_shared/store_test.ts`
Expected: FAIL — `store.upsertScheduleAssignment is not a function` (TypeScript type errors on the new methods not existing on `Store`).

- [ ] **Step 3: Add the type and interface methods**

In `src/_shared/store.ts`, add after the `Admin` interface:

```ts
export interface ScheduleAssignment {
  id: string;
  employeeId: string;
  shiftDate: string; // "2026-09-30"
  startTime: string; // "08:30"
  endTime: string; // "14:30"
}
```

In the `Store` interface, add after the `getSchedule()` line:

```ts
  /** Who's actually scheduled to work — drives cron reminder/lateness targeting, not a hard gate on OPEN/CLOSER. */
  listScheduleAssignmentsForDate(shiftDate: string): Promise<ScheduleAssignment[]>;
  /** [fromDateInclusive, toDateExclusive), sorted by shiftDate ascending. */
  listScheduleAssignmentsBetween(fromDateInclusive: string, toDateExclusive: string): Promise<ScheduleAssignment[]>;
  /** One row per (employeeId, shiftDate) — a second call for the same pair replaces the first, never duplicates. */
  upsertScheduleAssignment(employeeId: string, shiftDate: string, startTime: string, endTime: string): Promise<ScheduleAssignment>;
  removeScheduleAssignment(id: string): Promise<void>;
```

- [ ] **Step 4: Implement in `createInMemoryStore`**

Add the backing map next to `ephemeralMessages`:

```ts
  const scheduleAssignments = new Map<string, ScheduleAssignment>();
```

Add to the returned object, after `getSchedule`:

```ts
    async listScheduleAssignmentsForDate(shiftDate) {
      return [...scheduleAssignments.values()].filter((a) => a.shiftDate === shiftDate);
    },
    async listScheduleAssignmentsBetween(fromDateInclusive, toDateExclusive) {
      return [...scheduleAssignments.values()]
        .filter((a) => a.shiftDate >= fromDateInclusive && a.shiftDate < toDateExclusive)
        .sort((a, b) => (a.shiftDate < b.shiftDate ? -1 : a.shiftDate > b.shiftDate ? 1 : 0));
    },
    async upsertScheduleAssignment(employeeId, shiftDate, startTime, endTime) {
      for (const a of scheduleAssignments.values()) {
        if (a.employeeId === employeeId && a.shiftDate === shiftDate) {
          const updated = { ...a, startTime, endTime };
          scheduleAssignments.set(a.id, updated);
          return updated;
        }
      }
      const assignment: ScheduleAssignment = { id: makeId(), employeeId, shiftDate, startTime, endTime };
      scheduleAssignments.set(assignment.id, assignment);
      return assignment;
    },
    async removeScheduleAssignment(id) {
      scheduleAssignments.delete(id);
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/projects/smena-bot && deno test src/_shared/store_test.ts`
Expected: PASS (all tests in the file, including the 4 new ones).

- [ ] **Step 6: Write the migration**

Create `migrations/0006_add_schedule_assignments.sql`:

```sql
-- migrations/0006_add_schedule_assignments.sql
-- Who's actually scheduled to work which day — drives cron reminder/lateness targeting.
-- No unique constraint on (employee_id, shift_date): the admin editor enforces one row per
-- pair at the app level (upsertScheduleAssignment replaces, never duplicates).
create table schedule_assignments (
  id text primary key,
  employee_id text not null references employees(id),
  shift_date text not null,
  start_time text not null,
  end_time text not null
);
```

- [ ] **Step 7: Implement in `createD1Store`**

In `src/_shared/d1Store.ts`, add a row-mapping function next to `toAdmin`:

```ts
function toScheduleAssignment(row: Record<string, unknown>): ScheduleAssignment {
  return {
    id: row.id as string, employeeId: row.employee_id as string, shiftDate: row.shift_date as string,
    startTime: row.start_time as string, endTime: row.end_time as string,
  };
}
```

The file's top import is:
```ts
import type {
  Admin, ChecklistItem, ChecklistPhase, ChecklistProgress, Employee,
  ExpiryItem, InstructionArticle, ScheduleDay, Shift, Store,
} from "./store.ts";
```
Add `ScheduleAssignment` alphabetically, between `InstructionArticle` and `ScheduleDay`:
```ts
import type {
  Admin, ChecklistItem, ChecklistPhase, ChecklistProgress, Employee,
  ExpiryItem, InstructionArticle, ScheduleAssignment, ScheduleDay, Shift, Store,
} from "./store.ts";
```

Add to the returned object, after the `getSchedule` implementation:

```ts
    async listScheduleAssignmentsForDate(shiftDate) {
      return (await all("select * from schedule_assignments where shift_date = ?", shiftDate)).map(toScheduleAssignment);
    },
    async listScheduleAssignmentsBetween(fromDateInclusive, toDateExclusive) {
      return (await all(
        "select * from schedule_assignments where shift_date >= ? and shift_date < ? order by shift_date",
        fromDateInclusive, toDateExclusive,
      )).map(toScheduleAssignment);
    },
    async upsertScheduleAssignment(employeeId, shiftDate, startTime, endTime) {
      const existing = await first(
        "select id from schedule_assignments where employee_id = ? and shift_date = ?",
        employeeId, shiftDate,
      );
      if (existing) {
        await run("update schedule_assignments set start_time = ?, end_time = ? where id = ?", startTime, endTime, existing.id);
        return { id: existing.id as string, employeeId, shiftDate, startTime, endTime };
      }
      const id = makeId();
      await run(
        "insert into schedule_assignments (id, employee_id, shift_date, start_time, end_time) values (?, ?, ?, ?, ?)",
        id, employeeId, shiftDate, startTime, endTime,
      );
      return { id, employeeId, shiftDate, startTime, endTime };
    },
    async removeScheduleAssignment(id) {
      await run("delete from schedule_assignments where id = ?", id);
    },
```

Note: `d1Store.ts` has no test file of its own (it's exercised only by the live D1 in Task 6) — the in-memory implementation above is what Task 1's tests actually check. Keep the two implementations' behavior identical (same upsert/filter/sort semantics).

- [ ] **Step 8: Run the full suite to confirm no regressions**

Run: `cd ~/projects/smena-bot && deno test src/`
Expected: PASS, all tests (160+).

- [ ] **Step 9: Commit**

```bash
git add src/_shared/store.ts src/_shared/store_test.ts src/_shared/d1Store.ts migrations/0006_add_schedule_assignments.sql
git commit -m "Add ScheduleAssignment to the Store: who's scheduled to work which day"
```

---

### Task 2: Retarget `cron-tick/run.ts` to scheduled employees; bring the name back into lateness notices

**Files:**
- Modify: `src/cron-tick/run.ts`
- Modify: `src/cron-tick/run_test.ts`

**Interfaces:**
- Consumes: `Store.listScheduleAssignmentsForDate(shiftDate: string): Promise<ScheduleAssignment[]>` (Task 1); `ScheduleAssignment { employeeId, shiftDate, startTime, endTime }` (Task 1); `decideReminders(now: Date, scheduleDay: ScheduleDay, shift: Shift): ReminderAction[]` (unchanged, `src/_shared/reminders.ts`).
- Produces: `runCronTick` behavior change only — no new exports.

This task **replaces** the 2026-09-30 `shiftAlreadyHandledToday` patch and the I1 `lateAlreadyNotifiedThisTick` per-tick dedup, both in the same file. Read the current file first — several existing tests need rewriting, not just adding to.

- [ ] **Step 1: Replace the test file's scenarios that assumed "all active employees get checked"**

Replace the full contents of `src/cron-tick/run_test.ts` with:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../_shared/store.ts";
import type { TelegramClient } from "../_shared/telegram.ts";
import { runCronTick } from "./run.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); return { messageId: sent.length }; },
    async sendPhoto() {}, async deleteMessage() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };
  return { client, sent };
}

// 2026-09-21 is a Monday.
function atVenueTime(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 8, 21, h - 3, m));
}

Deno.test("a scheduled employee 9 minutes from their own start time gets the reminder exactly once across repeated ticks", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "19:30");
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:21"));
  await runCronTick(store, client, atVenueTime("08:22")); // a second tick a minute later must not re-send

  const reminders = sent.filter((m) => m.chatId === 1 && m.text.includes("Через 10 минут открытие"));
  assertEquals(reminders.length, 1);
});

Deno.test("an employee with no schedule assignment for today gets no reminder and no lateness check, even past opening time", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна"); // registered, but not scheduled for today
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:35"));

  assertEquals(sent.filter((m) => m.chatId === 1).length, 0);
});

Deno.test("the lateness notice names the specific scheduled employee and their own start time", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const employee = await store.addEmployee(1, "Вика");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "14:30");
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:30"));

  const lateNotice = sent.find((m) => m.chatId === 999 && m.text.includes("Опоздание"));
  assertEquals(lateNotice?.text, "🔴 Опоздание: Вика не открыл(а) смену вовремя (по графику 08:30).");
});

Deno.test("a scheduled employee who never opens gets exactly one lateness notice, not one per tick", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "19:30");
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:30"));
  await runCronTick(store, client, atVenueTime("08:35"));

  const lateNotices = sent.filter((m) => m.chatId === 999 && m.text.includes("Опоздание"));
  assertEquals(lateNotices.length, 1);
});

Deno.test("two employees scheduled the same day with different start times who are both late get two separate notices, not deduped", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const morning = await store.addEmployee(1, "Вика");
  const afternoon = await store.addEmployee(2, "Сабина");
  await store.upsertScheduleAssignment(morning.id, "2026-09-21", "08:30", "14:30");
  await store.upsertScheduleAssignment(afternoon.id, "2026-09-21", "14:30", "20:00");
  const { client, sent } = fakeTelegram();

  // Past both start times; neither has opened.
  await runCronTick(store, client, atVenueTime("15:00"));

  const lateNotices = sent.filter((m) => m.chatId === 999 && m.text.includes("Опоздание"));
  assertEquals(lateNotices.length, 2);
  assertEquals(lateNotices.some((m) => m.text.includes("Вика")), true);
  assertEquals(lateNotices.some((m) => m.text.includes("Сабина")), true);
});

Deno.test("an open shift past 14:20 gets the X-report reminder with the 'Ввести отчёт' button", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "19:30");
  const shift = await store.createShift(employee.id, "2026-09-21");
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("14:20"));

  const reminder = sent.find((m) => m.chatId === 1 && m.text.includes("контрольного X-отчёта"));
  assertEquals(reminder?.replyMarkup, { inline_keyboard: [[{ text: "Ввести отчёт", callback_data: "xreport:start" }]] });
});

Deno.test("an inactive employee is skipped even if a schedule assignment still exists for them", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Уволена");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "19:30");
  await store.removeEmployee(employee.id); // soft-delete; the assignment row is untouched
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("08:30"));

  assertEquals(sent.filter((m) => m.chatId === 1).length, 0);
});

Deno.test("a shift already closed today is left alone (no reminders re-fire after closing)", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-21", "08:30", "19:30");
  const shift = await store.createShift(employee.id, "2026-09-21");
  await store.updateShift(shift.id, { status: "closed" });
  const { client, sent } = fakeTelegram();

  await runCronTick(store, client, atVenueTime("19:25"));

  assertEquals(sent.filter((m) => m.chatId === 1).length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/projects/smena-bot && deno test src/cron-tick/run_test.ts`
Expected: FAIL — most tests fail because `run.ts` still iterates all active employees regardless of schedule, so unscheduled-employee tests get unwanted messages and the lateness message text doesn't match the new naming format.

- [ ] **Step 3: Rewrite `runCronTick` and `applyAction`**

Replace the full contents of `src/cron-tick/run.ts` with:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/projects/smena-bot && deno test src/cron-tick/run_test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `cd ~/projects/smena-bot && deno test src/`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/cron-tick/run.ts src/cron-tick/run_test.ts
git commit -m "Retarget cron reminders/lateness to scheduled employees; name comes back into lateness notices"
```

---

### Task 3: Schedule date/time text parsing

**Files:**
- Create: `src/telegram-webhook/handlers/admin/scheduleParsing.ts`
- Create: `src/telegram-webhook/handlers/admin/scheduleParsing_test.ts`

**Interfaces:**
- Produces: `parseScheduleDate(text: string, now?: Date): string | null` (returns a `shiftDate` key like `"2026-09-30"`, rolling to next year if the day/month already passed this year); `parseScheduleTime(text: string): { startTime: string; endTime: string } | null`.
- Consumes: `todayDateKey(now?: Date): string` from `src/_shared/time.ts` (already exists).

- [ ] **Step 1: Write the failing tests**

Create `src/telegram-webhook/handlers/admin/scheduleParsing_test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseScheduleDate, parseScheduleTime } from "./scheduleParsing.ts";

function onDate(iso: string): Date {
  return new Date(iso); // UTC midnight; venue offset doesn't matter for these date-only tests
}

Deno.test("parseScheduleDate reads D.M as this year when the date hasn't passed yet", () => {
  const now = onDate("2026-09-01T00:00:00Z");
  assertEquals(parseScheduleDate("30.09", now), "2026-09-30");
});

Deno.test("parseScheduleDate accepts today's own date", () => {
  const now = onDate("2026-09-30T00:00:00Z");
  assertEquals(parseScheduleDate("30.09", now), "2026-09-30");
});

Deno.test("parseScheduleDate rolls to next year when the date already passed this year", () => {
  const now = onDate("2026-10-05T00:00:00Z");
  assertEquals(parseScheduleDate("30.09", now), "2027-09-30");
});

Deno.test("parseScheduleDate pads single-digit day/month", () => {
  const now = onDate("2026-01-01T00:00:00Z");
  assertEquals(parseScheduleDate("5.3", now), "2026-03-05");
});

Deno.test("parseScheduleDate rejects garbage and out-of-range values", () => {
  const now = onDate("2026-09-01T00:00:00Z");
  assertEquals(parseScheduleDate("не дата", now), null);
  assertEquals(parseScheduleDate("30/09", now), null);
  assertEquals(parseScheduleDate("32.09", now), null);
  assertEquals(parseScheduleDate("30.13", now), null);
});

Deno.test("parseScheduleTime reads HH:MM-HH:MM", () => {
  assertEquals(parseScheduleTime("08:30-14:30"), { startTime: "08:30", endTime: "14:30" });
});

Deno.test("parseScheduleTime accepts an en dash or spaces around the dash", () => {
  assertEquals(parseScheduleTime("08:30 – 14:30"), { startTime: "08:30", endTime: "14:30" });
  assertEquals(parseScheduleTime("9:00-15:00"), { startTime: "09:00", endTime: "15:00" });
});

Deno.test("parseScheduleTime rejects garbage", () => {
  assertEquals(parseScheduleTime("весь день"), null);
  assertEquals(parseScheduleTime("08:30"), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/projects/smena-bot && deno test src/telegram-webhook/handlers/admin/scheduleParsing_test.ts`
Expected: FAIL — module `./scheduleParsing.ts` does not exist.

- [ ] **Step 3: Implement the parsers**

Create `src/telegram-webhook/handlers/admin/scheduleParsing.ts`:

```ts
import { todayDateKey } from "../../../_shared/time.ts";

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function parseScheduleDate(text: string, now: Date = new Date()): string | null {
  const match = /^(\d{1,2})\.(\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const todayKey = todayDateKey(now);
  const year = Number(todayKey.slice(0, 4));

  let candidate = `${year}-${pad2(month)}-${pad2(day)}`;
  if (candidate < todayKey) {
    candidate = `${year + 1}-${pad2(month)}-${pad2(day)}`;
  }
  return candidate;
}

export function parseScheduleTime(text: string): { startTime: string; endTime: string } | null {
  const match = /^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [, h1, m1, h2, m2] = match;
  return { startTime: `${pad2(Number(h1))}:${m1}`, endTime: `${pad2(Number(h2))}:${m2}` };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/projects/smena-bot && deno test src/telegram-webhook/handlers/admin/scheduleParsing_test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telegram-webhook/handlers/admin/scheduleParsing.ts src/telegram-webhook/handlers/admin/scheduleParsing_test.ts
git commit -m "Add date/time text parsing for the schedule editor"
```

---

### Task 4: Admin schedule editor (`/admin → 📅 График`)

**Files:**
- Create: `src/telegram-webhook/handlers/admin/schedule.ts`
- Create: `src/telegram-webhook/handlers/admin/schedule_test.ts`

**Interfaces:**
- Consumes: `parseScheduleDate`, `parseScheduleTime` (Task 3); `Store.listScheduleAssignmentsBetween`, `Store.upsertScheduleAssignment`, `Store.removeScheduleAssignment`, `Store.listEmployees` (Task 1 + existing); `sendEphemeral(store, telegram, telegramId, chatId, text, opts?)`, `clearEphemeral(store, telegram, telegramId)` from `../../ephemeral.ts` (existing); `todayDateKey(now?)` from `../../../_shared/time.ts` (existing).
- Produces: `openScheduleEditor(store, telegram, chatId: number, telegramId: number): Promise<void>`; `handleScheduleAddStart(store, telegram, callbackQuery): Promise<void>`; `handleScheduleDateText(store, telegram, message): Promise<void>`; `handleSchedulePick(store, telegram, callbackQuery, indexStr: string): Promise<void>`; `handleScheduleTimeText(store, telegram, message): Promise<void>`; `handleScheduleDelete(store, telegram, callbackQuery, indexStr: string): Promise<void>`; `handleScheduleDone(store, telegram, callbackQuery): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `src/telegram-webhook/handlers/admin/schedule_test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../../_shared/telegram.ts";
import {
  handleScheduleAddStart, handleScheduleDateText, handleScheduleDelete,
  handleScheduleDone, handleSchedulePick, handleScheduleTimeText, openScheduleEditor,
} from "./schedule.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const edited: { chatId: number; messageId: number; markup: unknown }[] = [];
  const answered: { id: string; text?: string }[] = [];
  const deleted: { chatId: number; messageId: number }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); return { messageId: sent.length }; },
    async sendPhoto() {},
    async deleteMessage(chatId, messageId) { deleted.push({ chatId, messageId }); },
    async answerCallbackQuery(id, text) { answered.push({ id, text }); },
    async editMessageReplyMarkup(chatId, messageId, markup) { edited.push({ chatId, messageId, markup }); },
    async setWebhook() {},
  };
  return { client, sent, edited, answered, deleted };
}

function msg(fromId: number, text: string): TelegramMessage {
  return { message_id: 1, from: { id: fromId, first_name: "RCA" }, chat: { id: fromId }, text };
}

function cbq(data: string): TelegramCallbackQuery {
  return { id: "cbq", from: { id: 1, first_name: "RCA" }, message: { chat: { id: 1 }, message_id: 9 }, data };
}

Deno.test("openScheduleEditor lists upcoming assignments as 'DD.MM Имя start-end', plus Добавить and Готово", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  const { client, sent } = fakeTelegram();

  await openScheduleEditor(store, client, 1, 1);

  const keyboard = sent[0].replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assertEquals(keyboard.inline_keyboard[0][0].text, "30.09 Анна 08:30-14:30");
  assertEquals(keyboard.inline_keyboard.length, 3); // 1 row + Добавить + Готово
});

Deno.test("handleScheduleAddStart starts the date-capture session and prompts for it", async () => {
  const store = createInMemoryStore();
  const { client, sent, answered } = fakeTelegram();

  await handleScheduleAddStart(store, client, cbq("admin:schedule:add"));

  assertEquals(await store.getSession(1), { state: "admin_schedule_date", data: {} });
  assertEquals(sent[0].text.includes("30.09"), true);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("handleScheduleDateText with an invalid date re-prompts and keeps the session alive", async () => {
  const store = createInMemoryStore();
  await store.setSession(1, "admin_schedule_date", {});
  const { client, sent } = fakeTelegram();

  await handleScheduleDateText(store, client, msg(1, "не дата"));

  assertEquals(sent[0].text.includes("Не понял дату"), true);
  assertEquals((await store.getSession(1)).state, "admin_schedule_date");
});

Deno.test("handleScheduleDateText with a valid date moves to employee-picking and offers active employees", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  await store.addEmployee(2, "Иван");
  await store.setSession(10, "admin_schedule_date", {});
  const { client, sent } = fakeTelegram();

  await handleScheduleDateText(store, client, msg(10, "30.09"));

  assertEquals(await store.getSession(10), { state: "admin_schedule_employee", data: { date: "2026-09-30" } });
  const keyboard = sent[0].replyMarkup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assertEquals(keyboard.inline_keyboard, [
    [{ text: "Анна", callback_data: "admin:schedule:pick:0" }],
    [{ text: "Иван", callback_data: "admin:schedule:pick:1" }],
  ]);
});

Deno.test("handleSchedulePick moves to time-capture, remembering the date and the picked employee", async () => {
  const store = createInMemoryStore();
  const anna = await store.addEmployee(1, "Анна");
  await store.addEmployee(2, "Иван");
  await store.setSession(1, "admin_schedule_employee", { date: "2026-09-30" });
  const { client, sent, answered } = fakeTelegram();

  await handleSchedulePick(store, client, cbq("admin:schedule:pick:0"), "0");

  assertEquals(await store.getSession(1), { state: "admin_schedule_time", data: { date: "2026-09-30", employeeId: anna.id } });
  assertEquals(sent[0].text.includes("08:30-14:30"), true);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("handleSchedulePick on an out-of-range index answers harmlessly and changes nothing", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  await store.setSession(1, "admin_schedule_employee", { date: "2026-09-30" });
  const { client, answered } = fakeTelegram();

  await handleSchedulePick(store, client, cbq("admin:schedule:pick:5"), "5");

  assertEquals((await store.getSession(1)).state, "admin_schedule_employee");
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("handleScheduleTimeText with an invalid time re-prompts and keeps the session alive", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.setSession(1, "admin_schedule_time", { date: "2026-09-30", employeeId: employee.id });
  const { client, sent } = fakeTelegram();

  await handleScheduleTimeText(store, client, msg(1, "весь день"));

  assertEquals(sent[0].text.includes("Не понял время"), true);
  assertEquals((await store.getSession(1)).state, "admin_schedule_time");
});

Deno.test("handleScheduleTimeText with a valid time saves the assignment, clears the session, and re-opens the editor", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.setSession(1, "admin_schedule_time", { date: "2026-09-30", employeeId: employee.id });
  const { client, sent } = fakeTelegram();

  await handleScheduleTimeText(store, client, msg(1, "08:30-14:30"));

  const rows = await store.listScheduleAssignmentsForDate("2026-09-30");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].startTime, "08:30");
  assertEquals((await store.getSession(1)).state, null);
  assertEquals(sent[sent.length - 1].text.includes("30.09 Анна 08:30-14:30"), true);
});

Deno.test("adding a second assignment for the same employee and date replaces the first, does not duplicate it", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  await store.setSession(1, "admin_schedule_time", { date: "2026-09-30", employeeId: employee.id });
  const { client } = fakeTelegram();

  await handleScheduleTimeText(store, client, msg(1, "09:00-15:00"));

  const rows = await store.listScheduleAssignmentsForDate("2026-09-30");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].startTime, "09:00");
});

Deno.test("handleScheduleDelete removes the row (addressed by list position) and edits the keyboard in place", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  const { client, edited, answered } = fakeTelegram();

  await handleScheduleDelete(store, client, cbq("admin:schedule:del:0"), "0");

  assertEquals((await store.listScheduleAssignmentsForDate("2026-09-30")).length, 0);
  assertEquals(edited[0].messageId, 9);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("deleting an assignment does not touch an already-created shift row for that date", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  const shift = await store.createShift(employee.id, "2026-09-30");
  await store.updateShift(shift.id, { status: "open", openedAt: "2026-09-30T08:23:00.000Z" });
  const { client } = fakeTelegram();

  await handleScheduleDelete(store, client, cbq("admin:schedule:del:0"), "0");

  const stillThere = await store.getShiftById(shift.id);
  assertEquals(stillThere?.status, "open");
  assertEquals(stillThere?.openedAt, "2026-09-30T08:23:00.000Z");
});

Deno.test("handleScheduleDelete on an out-of-range position answers harmlessly and changes nothing", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  const { client, edited, answered } = fakeTelegram();

  await handleScheduleDelete(store, client, cbq("admin:schedule:del:7"), "7");

  assertEquals((await store.listScheduleAssignmentsForDate("2026-09-30")).length, 1);
  assertEquals(edited, []);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("handleScheduleDone clears the session and deletes the last editor message", async () => {
  const store = createInMemoryStore();
  await store.setSession(1, "admin_schedule_date", {});
  await store.setLastEphemeralMessage(1, 1, 42);
  const { client, answered, deleted } = fakeTelegram();

  await handleScheduleDone(store, client, cbq("admin:schedule:done"));

  assertEquals((await store.getSession(1)).state, null);
  assertEquals(deleted, [{ chatId: 1, messageId: 42 }]);
  assertEquals(answered, [{ id: "cbq", text: "Сохранено." }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/projects/smena-bot && deno test src/telegram-webhook/handlers/admin/schedule_test.ts`
Expected: FAIL — module `./schedule.ts` does not exist.

- [ ] **Step 3: Implement the editor**

Create `src/telegram-webhook/handlers/admin/schedule.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/projects/smena-bot && deno test src/telegram-webhook/handlers/admin/schedule_test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `cd ~/projects/smena-bot && deno test src/`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/telegram-webhook/handlers/admin/schedule.ts src/telegram-webhook/handlers/admin/schedule_test.ts
git commit -m "Add the /admin schedule editor: list, add (date→employee→time), delete, done"
```

---

### Task 5: Wire the schedule editor into the admin menu, admin callback router, and session router

**Files:**
- Modify: `src/telegram-webhook/handlers/admin/menu.ts`
- Modify: `src/telegram-webhook/handlers/admin/router.ts`
- Modify: `src/telegram-webhook/handlers/admin/router_test.ts`
- Modify: `src/telegram-webhook/router.ts`

**Interfaces:**
- Consumes: all seven exports from `./schedule.ts` (Task 4).
- Produces: no new exports — this task only wires existing pieces together.

- [ ] **Step 1: Write the failing router tests**

Add to `src/telegram-webhook/handlers/admin/router_test.ts` (this file already has `fakeTelegram`/`cbq` helpers — reuse them):

```ts
Deno.test("admin:menu:schedule opens the schedule editor", async () => {
  const store = createInMemoryStore();
  const { client, sent, answered } = fakeTelegram();

  await routeAdminCallback(store, client, cbq("admin:menu:schedule"));

  assertEquals(sent[0].text, "Ближайший график:");
  assertEquals(answered.length, 1);
});

Deno.test("admin:schedule:add starts the date-capture session", async () => {
  const store = createInMemoryStore();
  const { client } = fakeTelegram();

  await routeAdminCallback(store, client, cbq("admin:schedule:add"));

  assertEquals((await store.getSession(1)).state, "admin_schedule_date");
});

Deno.test("admin:schedule:pick:<index> with no employees answers harmlessly instead of crashing", async () => {
  const store = createInMemoryStore();
  await store.setSession(1, "admin_schedule_employee", { date: "2026-09-30" });
  const { client, answered } = fakeTelegram();

  await routeAdminCallback(store, client, cbq("admin:schedule:pick:0"));

  assertEquals(answered, [{ id: "cbq", text: undefined }]);
});

Deno.test("admin:schedule:del:<index> deletes the row at that position", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.upsertScheduleAssignment(employee.id, "2026-09-30", "08:30", "14:30");
  const { client } = fakeTelegram();

  await routeAdminCallback(store, client, cbq("admin:schedule:del:0"));

  assertEquals((await store.listScheduleAssignmentsForDate("2026-09-30")).length, 0);
});

Deno.test("admin:schedule:done clears the session", async () => {
  const store = createInMemoryStore();
  await store.setSession(1, "admin_schedule_date", {});
  const { client } = fakeTelegram();

  await routeAdminCallback(store, client, cbq("admin:schedule:done"));

  assertEquals((await store.getSession(1)).state, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/projects/smena-bot && deno test src/telegram-webhook/handlers/admin/router_test.ts`
Expected: FAIL — `admin:menu:schedule`/`admin:schedule:*` all fall through to the unrecognized-callback branch, so assertions on `sent`/session state fail.

- [ ] **Step 3: Wire `admin/menu.ts`**

In `src/telegram-webhook/handlers/admin/menu.ts`, add the import:

```ts
import { openScheduleEditor } from "./schedule.ts";
```

In `renderAdminMenuKeyboard`, add a new row (position doesn't matter functionally — put it after Чек-лист закрытия, before Инструкции, to match the order it was discussed in):

```ts
      [{ text: "✏️ Чек-лист открытия", callback_data: "admin:menu:checklist_open" }],
      [{ text: "✅ Чек-лист закрытия", callback_data: "admin:menu:checklist_close" }],
      [{ text: "📅 График", callback_data: "admin:menu:schedule" }],
      [{ text: "📖 Инструкции", callback_data: "admin:menu:instructions" }],
```

In `handleAdminMenuSelect`, add a branch before the final fallback (after the `instructions` branch, alongside `peopleConfig`/`config`):

```ts
  if (key === "schedule") {
    await openScheduleEditor(store, telegram, callbackQuery.message.chat.id, callbackQuery.from.id);
    await telegram.answerCallbackQuery(callbackQuery.id);
    return;
  }
```

- [ ] **Step 4: Wire `admin/router.ts`**

In `src/telegram-webhook/handlers/admin/router.ts`, add the import:

```ts
import { handleScheduleAddStart, handleScheduleDelete, handleScheduleDone, handleSchedulePick } from "./schedule.ts";
```

Add branches before the final `await telegram.answerCallbackQuery(callbackQuery.id);` fallback:

```ts
  if (parts[1] === "schedule" && parts[2] === "add") {
    await handleScheduleAddStart(store, telegram, callbackQuery);
    return;
  }
  if (parts[1] === "schedule" && parts[2] === "pick" && parts[3]) {
    await handleSchedulePick(store, telegram, callbackQuery, parts[3]);
    return;
  }
  if (parts[1] === "schedule" && parts[2] === "del" && parts[3]) {
    await handleScheduleDelete(store, telegram, callbackQuery, parts[3]);
    return;
  }
  if (parts[1] === "schedule" && parts[2] === "done") {
    await handleScheduleDone(store, telegram, callbackQuery);
    return;
  }
```

- [ ] **Step 5: Run the router tests to verify they pass**

Run: `cd ~/projects/smena-bot && deno test src/telegram-webhook/handlers/admin/router_test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Wire the text-message session router**

In `src/telegram-webhook/router.ts`, add the import:

```ts
import { handleScheduleDateText, handleScheduleTimeText } from "./handlers/admin/schedule.ts";
```

Add two branches alongside the other `admin_*` session checks (same admin-guard pattern as `admin_instruction_title`):

```ts
  if (session.state === "admin_schedule_date") {
    if (await store.getAdminByTelegramId(message.from.id)) {
      await handleScheduleDateText(store, telegram, message);
    }
    return;
  }
  if (session.state === "admin_schedule_time") {
    if (await store.getAdminByTelegramId(message.from.id)) {
      await handleScheduleTimeText(store, telegram, message);
    }
    return;
  }
```

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `cd ~/projects/smena-bot && deno test src/`
Expected: PASS, all tests.

- [ ] **Step 8: Commit**

```bash
git add src/telegram-webhook/handlers/admin/menu.ts src/telegram-webhook/handlers/admin/router.ts src/telegram-webhook/handlers/admin/router_test.ts src/telegram-webhook/router.ts
git commit -m "Wire the schedule editor into the admin menu and both routers"
```

---

### Task 6: Apply the migration and deploy

**Files:** none (operational task — no code changes).

- [ ] **Step 1: Run the full suite one last time**

Run: `cd ~/projects/smena-bot && deno test src/`
Expected: PASS, all tests (170+).

- [ ] **Step 2: Apply the migration locally**

Run: `cd ~/projects/smena-bot && npx wrangler d1 execute smena-bot-db --local --file=migrations/0006_add_schedule_assignments.sql`
Expected: `🚣 1 command executed successfully.`

- [ ] **Step 3: Apply the migration to the remote production database**

Requires `CLOUDFLARE_API_TOKEN` in the environment (same token used for every prior deploy this project).
Run: `cd ~/projects/smena-bot && export CLOUDFLARE_API_TOKEN='<token>' && npx wrangler d1 execute smena-bot-db --remote --file=migrations/0006_add_schedule_assignments.sql`
Expected: `🚣 Executed 1 queries` with `"success": true`.

- [ ] **Step 4: Deploy the Worker**

Run: `cd ~/projects/smena-bot && export CLOUDFLARE_API_TOKEN='<token>' && npx wrangler deploy`
Expected: `Deployed smena-bot triggers` with a new Version ID.

- [ ] **Step 5: Smoke-check in the live bot**

As an admin: `/admin → 📅 График`, add an assignment for today with a start time a few minutes in the future, confirm the reminder arrives; confirm an employee with no assignment gets nothing.
