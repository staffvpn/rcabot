# СменаБот Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Telegram bot that walks a single café's cashier through opening/closing a shift with an editable checklist, cash-discrepancy and lateness checks, a control X-report reminder, a Quick-Resto-sourced instructions library, and a self-service `/admin` menu for the client to edit everything without a developer.

**Architecture:** Supabase Postgres holds all state; a single Telegram webhook Edge Function (Deno) handles every user interaction through a small message/callback router; a second `cron-tick` Edge Function, invoked every 5 minutes by `pg_cron`, sends the time-based reminders (opening/closing/X-report/lateness). All business logic is written against one `Store` interface so it can be unit-tested with an in-memory fake instead of a live database.

**Tech Stack:** Supabase (Postgres, Edge Functions on Deno, Storage, `pg_cron`), Telegram Bot API (raw `fetch`, no bot framework), Deno's built-in test runner.

**Spec:** `docs/superpowers/specs/2026-09-25-smena-bot-design.md`

## Global Constraints

- Single venue, single Quick Resto Windows terminal — no multi-location code paths (spec §2).
- No Quick Resto API integration — all POS actions stay manual; the bot only records numbers/photos the employee reports (spec §2).
- Cash/размен discrepancies only warn, never block shift opening (spec §6.2).
- No dedicated X-report history screen — raw figures are stored on `shifts` but no reporting UI is built (spec §6.4, §8).
- All content (both checklists, instructions, expiry list, employees, admins) must be editable from inside the bot's `/admin` menu — no separate website (spec §6.8, §8).
- The system must never allow removing the last remaining admin (spec §6.8).

## Review Focus

- An unregistered Telegram user (not in `employees` or `admins`) messages the bot — must get a clear "not registered" reply, never a crash or silent admin access.
- Employee presses OPEN when a shift for today is already open — must be told it's already open, not restarted through the checklist from scratch.
- Employee presses CLOSER before ever opening a shift today — must be told to open first, not crash on a missing shift row.
- A non-admin sends `/admin` or taps an admin-only callback — must be silently rejected (no menu, no error leaking admin structure).
- Employee types non-numeric text where a cash amount is expected (размен, X-report figures, closing float) — must get a re-prompt explaining the expected format, not a thrown error or a `NaN` stored in the database.

---

### Task 1: Database schema & seed data

**Files:**
- Create: `supabase/migrations/0001_init.sql`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the Postgres schema every later task's `Store` implementation reads and writes — table/column names below are load-bearing for Task 3.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0001_init.sql
create extension if not exists pgcrypto;

create table employees (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  full_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table admins (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  full_name text not null,
  created_at timestamptz not null default now()
);

create table schedule (
  weekday smallint primary key check (weekday between 0 and 6), -- 0 = Monday .. 6 = Sunday
  opens_at time not null,
  closes_at time not null
);

create table checklist_items (
  id uuid primary key default gen_random_uuid(),
  phase text not null check (phase in ('open','close')),
  position int not null,
  label text not null,
  requires_photo boolean not null default false
);

create table instructions (
  id uuid primary key default gen_random_uuid(),
  position int not null,
  title text not null,
  body text not null,
  media_url text
);

create table expiry_items (
  id uuid primary key default gen_random_uuid(),
  position int not null,
  name text not null,
  shelf_life_days int not null
);

create table shifts (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id),
  shift_date date not null,
  opened_at timestamptz,
  closed_at timestamptz,
  open_cash_amount numeric(10,2),
  closing_float_amount numeric(10,2),
  cash_discrepancy numeric(10,2),
  xreport_cash numeric(10,2),
  xreport_cashless numeric(10,2),
  xreport_at timestamptz,
  status text not null default 'pending' check (status in ('pending','open','closed')),
  reminded_open_at timestamptz,
  notified_late_at timestamptz,
  reminded_close_at timestamptz,
  reminded_xreport_at timestamptz,
  unique (employee_id, shift_date)
);

create table shift_checklist_progress (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references shifts(id) on delete cascade,
  checklist_item_id uuid not null references checklist_items(id) on delete cascade,
  done boolean not null default false,
  photo_file_id text,
  unique (shift_id, checklist_item_id)
);

create table bot_sessions (
  telegram_id bigint primary key,
  state text,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- seed: schedule (Mon-Fri 08:30-19:30, Sat 09:00-19:00, Sun 09:00-18:00)
insert into schedule (weekday, opens_at, closes_at) values
  (0,'08:30','19:30'), (1,'08:30','19:30'), (2,'08:30','19:30'),
  (3,'08:30','19:30'), (4,'08:30','19:30'),
  (5,'09:00','19:00'),
  (6,'09:00','18:00');

-- seed: default checklists
insert into checklist_items (phase, position, label, requires_photo) values
  ('open', 1, 'Кофемашина прогрета', false),
  ('open', 2, 'Терминал включён', false),
  ('open', 3, 'Зал чистый', false),
  ('close', 1, 'Фото отчёта с кассы', true);

-- seed: expiry list from the client's dessert shelf-life sheet
insert into expiry_items (position, name, shelf_life_days) values
  (1,'Канеле',2), (2,'Пирог миндаль',5), (3,'Чизкейк',3),
  (4,'Пирог смородина',5), (5,'Пирог вишня',5), (6,'Тарт лимонный',3),
  (7,'Кексы',5), (8,'Наполеон',5), (9,'Медовик',5), (10,'Картошка',5);
```

- [ ] **Step 2: Apply the migration to the local Supabase stack**

Run: `supabase start` (first time only), then `supabase db reset`
Expected: output ends with `Finished supabase db reset` and no SQL errors.

- [ ] **Step 3: Verify the seed data landed**

Run:
```bash
supabase db execute --sql "select (select count(*) from schedule) as schedule_rows, (select count(*) from checklist_items) as checklist_rows, (select count(*) from expiry_items) as expiry_rows;"
```
Expected: `schedule_rows = 7`, `checklist_rows = 4`, `expiry_rows = 10`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_init.sql
git commit -m "Add initial database schema and seed data"
```

---

### Task 2: Telegram API client

**Files:**
- Create: `supabase/functions/_shared/telegram.ts`
- Test: `supabase/functions/_shared/telegram_test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createTelegramClient(botToken: string, fetchImpl?: typeof fetch): TelegramClient`, the `TelegramClient`, `TelegramUpdate`, `TelegramMessage`, `TelegramCallbackQuery`, `ReplyKeyboard`, `InlineKeyboard` types every later task imports from `_shared/telegram.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/_shared/telegram_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createTelegramClient } from "./telegram.ts";

Deno.test("sendMessage posts text and chat id to the sendMessage endpoint", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: input.toString(), body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  await client.sendMessage(12345, "hello");

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.telegram.org/botTEST_TOKEN/sendMessage");
  assertEquals(calls[0].body, { chat_id: 12345, text: "hello", reply_markup: undefined });
});

Deno.test("sendMessage attaches a reply_markup keyboard when given one", async () => {
  const calls: { body: Record<string, unknown> }[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push({ body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  await client.sendMessage(1, "menu", {
    replyMarkup: { inline_keyboard: [[{ text: "OPEN", callback_data: "shift:open" }]] },
  });

  assertEquals(calls[0].body.reply_markup, {
    inline_keyboard: [[{ text: "OPEN", callback_data: "shift:open" }]],
  });
});

Deno.test("sendMessage throws when Telegram responds with a non-2xx status", async () => {
  const fakeFetch: typeof fetch = async () => new Response("bad request", { status: 400 });
  const client = createTelegramClient("TEST_TOKEN", fakeFetch);

  let threw = false;
  try {
    await client.sendMessage(1, "x");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("answerCallbackQuery posts the callback query id", async () => {
  const calls: { body: Record<string, unknown> }[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push({ body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  await client.answerCallbackQuery("cbq-1", "Готово");

  assertEquals(calls[0].body, { callback_query_id: "cbq-1", text: "Готово" });
});

Deno.test("editMessageReplyMarkup posts chat id, message id, and the new markup", async () => {
  const calls: { body: Record<string, unknown> }[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push({ body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  const markup = { inline_keyboard: [[{ text: "✅ Готово", callback_data: "chk:open:1" }]] };
  await client.editMessageReplyMarkup(1, 42, markup);

  assertEquals(calls[0].body, { chat_id: 1, message_id: 42, reply_markup: markup });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test supabase/functions/_shared/telegram_test.ts`
Expected: FAIL — `telegram.ts` does not exist yet.

- [ ] **Step 3: Implement the client**

```ts
// supabase/functions/_shared/telegram.ts
const TELEGRAM_API = "https://api.telegram.org";

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: { id: number };
  text?: string;
  photo?: { file_id: string }[];
  forward_from?: TelegramUser;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message: { chat: { id: number }; message_id: number };
  data: string;
}

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface ReplyKeyboard {
  keyboard: string[][];
  resize_keyboard: true;
}

export type ReplyMarkup = InlineKeyboard | ReplyKeyboard | { remove_keyboard: true };

export interface SendMessageOptions {
  replyMarkup?: ReplyMarkup;
}

export interface TelegramClient {
  sendMessage(chatId: number, text: string, opts?: SendMessageOptions): Promise<void>;
  sendPhoto(chatId: number, fileId: string, caption?: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  editMessageReplyMarkup(chatId: number, messageId: number, markup: InlineKeyboard): Promise<void>;
  setWebhook(url: string, secretToken: string): Promise<void>;
}

export function createTelegramClient(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): TelegramClient {
  async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetchImpl(`${TELEGRAM_API}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Telegram API ${method} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  return {
    async sendMessage(chatId, text, opts) {
      await call("sendMessage", { chat_id: chatId, text, reply_markup: opts?.replyMarkup });
    },
    async sendPhoto(chatId, fileId, caption) {
      await call("sendPhoto", { chat_id: chatId, photo: fileId, caption });
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    },
    async editMessageReplyMarkup(chatId, messageId, markup) {
      await call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup });
    },
    async setWebhook(url, secretToken) {
      await call("setWebhook", { url, secret_token: secretToken });
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test supabase/functions/_shared/telegram_test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/telegram.ts supabase/functions/_shared/telegram_test.ts
git commit -m "Add Telegram API client"
```

---

### Task 3: Persistence layer (`Store` interface, in-memory fake, Supabase implementation)

Every later task reads and writes data only through the `Store` interface defined here — never directly through `supabase-js` or raw SQL. This is what lets every handler task be unit-tested with `createInMemoryStore()` instead of a live database.

**Files:**
- Create: `supabase/functions/_shared/store.ts` (types + `createInMemoryStore`)
- Create: `supabase/functions/_shared/supabaseStore.ts` (`createSupabaseStore`)
- Test: `supabase/functions/_shared/store_test.ts`

**Interfaces:**
- Consumes: table/column names from Task 1's migration (`supabaseStore.ts` only).
- Produces: the `Store` interface and every domain type (`Employee`, `Admin`, `ScheduleDay`, `ChecklistItem`, `InstructionArticle`, `ExpiryItem`, `Shift`, `ChecklistProgress`, `SessionState`) that Tasks 4–13 import from `_shared/store.ts`.

- [ ] **Step 1: Write the failing tests against the in-memory store**

```ts
// supabase/functions/_shared/store_test.ts
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "./store.ts";

Deno.test("addEmployee then getEmployeeByTelegramId returns the stored employee", async () => {
  const store = createInMemoryStore();
  const created = await store.addEmployee(555, "Анна");

  const found = await store.getEmployeeByTelegramId(555);
  assertEquals(found?.id, created.id);
  assertEquals(found?.fullName, "Анна");
  assertEquals(found?.active, true);
});

Deno.test("getEmployeeByTelegramId returns null for an unknown telegram id", async () => {
  const store = createInMemoryStore();
  assertEquals(await store.getEmployeeByTelegramId(999), null);
});

Deno.test("removeAdmin refuses to delete the last remaining admin", async () => {
  const store = createInMemoryStore();
  const admin = await store.addAdmin(1, "RCA");

  await assertRejects(() => store.removeAdmin(admin.id), Error, "last remaining admin");

  assertEquals((await store.listAdmins()).length, 1);
});

Deno.test("removeAdmin succeeds when at least one admin remains afterwards", async () => {
  const store = createInMemoryStore();
  const first = await store.addAdmin(1, "RCA");
  await store.addAdmin(2, "Мария");

  await store.removeAdmin(first.id);

  const remaining = await store.listAdmins();
  assertEquals(remaining.length, 1);
  assertEquals(remaining[0].fullName, "Мария");
});

Deno.test("listChecklistItems returns only items for the requested phase, in position order", async () => {
  const store = createInMemoryStore();
  await store.addChecklistItem("open", "Кофемашина прогрета", false);
  await store.addChecklistItem("close", "Фото отчёта с кассы", true);
  await store.addChecklistItem("open", "Зал чистый", false);

  const openItems = await store.listChecklistItems("open");
  assertEquals(openItems.map((i) => i.label), ["Кофемашина прогрета", "Зал чистый"]);
});

Deno.test("createShift then getShift round-trips, and updateShift patches fields", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const created = await store.createShift(employee.id, "2026-09-25");

  assertEquals(created.status, "pending");
  assertEquals(await store.getShift(employee.id, "2026-09-25"), created);

  const updated = await store.updateShift(created.id, { status: "open", openCashAmount: 3000 });
  assertEquals(updated.status, "open");
  assertEquals(updated.openCashAmount, 3000);
});

Deno.test("setChecklistProgress upserts by shift+item, and getChecklistProgress lists them", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  const item = await store.addChecklistItem("open", "Зал чистый", false);

  await store.setChecklistProgress(shift.id, item.id, true);
  await store.setChecklistProgress(shift.id, item.id, true); // idempotent, not duplicated

  const progress = await store.getChecklistProgress(shift.id);
  assertEquals(progress.length, 1);
  assertEquals(progress[0].done, true);
});

Deno.test("session get/set/clear round-trips per telegram id", async () => {
  const store = createInMemoryStore();
  assertEquals(await store.getSession(42), { state: null, data: {} });

  await store.setSession(42, "awaiting_open_cash", { shiftId: "abc" });
  assertEquals(await store.getSession(42), { state: "awaiting_open_cash", data: { shiftId: "abc" } });

  await store.clearSession(42);
  assertEquals(await store.getSession(42), { state: null, data: {} });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test supabase/functions/_shared/store_test.ts`
Expected: FAIL — `store.ts` does not exist yet.

- [ ] **Step 3: Implement the `Store` interface and the in-memory fake**

```ts
// supabase/functions/_shared/store.ts

export interface Employee {
  id: string;
  telegramId: number;
  fullName: string;
  active: boolean;
}

export interface Admin {
  id: string;
  telegramId: number;
  fullName: string;
}

export interface ScheduleDay {
  weekday: number; // 0 = Monday .. 6 = Sunday
  opensAt: string; // "08:30"
  closesAt: string; // "19:30"
}

export type ChecklistPhase = "open" | "close";

export interface ChecklistItem {
  id: string;
  phase: ChecklistPhase;
  position: number;
  label: string;
  requiresPhoto: boolean;
}

export interface InstructionArticle {
  id: string;
  position: number;
  title: string;
  body: string;
  mediaUrl: string | null;
}

export interface ExpiryItem {
  id: string;
  position: number;
  name: string;
  shelfLifeDays: number;
}

export type ShiftStatus = "pending" | "open" | "closed";

export interface Shift {
  id: string;
  employeeId: string;
  shiftDate: string; // "2026-09-25"
  openedAt: string | null;
  closedAt: string | null;
  openCashAmount: number | null;
  closingFloatAmount: number | null;
  cashDiscrepancy: number | null;
  xreportCash: number | null;
  xreportCashless: number | null;
  xreportAt: string | null;
  status: ShiftStatus;
  remindedOpenAt: string | null;
  notifiedLateAt: string | null;
  remindedCloseAt: string | null;
  remindedXreportAt: string | null;
}

export interface ChecklistProgress {
  shiftId: string;
  checklistItemId: string;
  done: boolean;
  photoFileId: string | null;
}

export interface SessionState {
  state: string | null;
  data: Record<string, unknown>;
}

export interface Store {
  getEmployeeByTelegramId(telegramId: number): Promise<Employee | null>;
  listEmployees(): Promise<Employee[]>;
  addEmployee(telegramId: number, fullName: string): Promise<Employee>;
  removeEmployee(id: string): Promise<void>;

  getAdminByTelegramId(telegramId: number): Promise<Admin | null>;
  listAdmins(): Promise<Admin[]>;
  addAdmin(telegramId: number, fullName: string): Promise<Admin>;
  removeAdmin(id: string): Promise<void>;

  getSchedule(): Promise<ScheduleDay[]>;

  listChecklistItems(phase: ChecklistPhase): Promise<ChecklistItem[]>;
  addChecklistItem(phase: ChecklistPhase, label: string, requiresPhoto: boolean): Promise<ChecklistItem>;
  removeChecklistItem(id: string): Promise<void>;

  listInstructions(): Promise<InstructionArticle[]>;
  addInstruction(title: string, body: string, mediaUrl: string | null): Promise<InstructionArticle>;
  removeInstruction(id: string): Promise<void>;

  listExpiryItems(): Promise<ExpiryItem[]>;
  addExpiryItem(name: string, shelfLifeDays: number): Promise<ExpiryItem>;
  removeExpiryItem(id: string): Promise<void>;

  getShift(employeeId: string, shiftDate: string): Promise<Shift | null>;
  getShiftById(id: string): Promise<Shift | null>;
  createShift(employeeId: string, shiftDate: string): Promise<Shift>;
  updateShift(id: string, patch: Partial<Shift>): Promise<Shift>;
  getPreviousShift(employeeId: string, beforeDate: string): Promise<Shift | null>;
  listShiftsForDate(shiftDate: string): Promise<Shift[]>;

  getChecklistProgress(shiftId: string): Promise<ChecklistProgress[]>;
  setChecklistProgress(
    shiftId: string,
    checklistItemId: string,
    done: boolean,
    photoFileId?: string | null,
  ): Promise<void>;

  getSession(telegramId: number): Promise<SessionState>;
  setSession(telegramId: number, state: string | null, data?: Record<string, unknown>): Promise<void>;
  clearSession(telegramId: number): Promise<void>;
}

function makeId(): string {
  return crypto.randomUUID();
}

export function createInMemoryStore(): Store {
  const employees = new Map<string, Employee>();
  const admins = new Map<string, Admin>();
  const checklistItems = new Map<string, ChecklistItem>();
  const instructions = new Map<string, InstructionArticle>();
  const expiryItems = new Map<string, ExpiryItem>();
  const shifts = new Map<string, Shift>();
  const progress = new Map<string, ChecklistProgress>(); // key: `${shiftId}:${checklistItemId}`
  const sessions = new Map<number, SessionState>();

  const schedule: ScheduleDay[] = [
    { weekday: 0, opensAt: "08:30", closesAt: "19:30" },
    { weekday: 1, opensAt: "08:30", closesAt: "19:30" },
    { weekday: 2, opensAt: "08:30", closesAt: "19:30" },
    { weekday: 3, opensAt: "08:30", closesAt: "19:30" },
    { weekday: 4, opensAt: "08:30", closesAt: "19:30" },
    { weekday: 5, opensAt: "09:00", closesAt: "19:00" },
    { weekday: 6, opensAt: "09:00", closesAt: "18:00" },
  ];

  return {
    async getEmployeeByTelegramId(telegramId) {
      for (const e of employees.values()) if (e.telegramId === telegramId) return e;
      return null;
    },
    async listEmployees() {
      return [...employees.values()];
    },
    async addEmployee(telegramId, fullName) {
      const employee: Employee = { id: makeId(), telegramId, fullName, active: true };
      employees.set(employee.id, employee);
      return employee;
    },
    async removeEmployee(id) {
      employees.delete(id);
    },

    async getAdminByTelegramId(telegramId) {
      for (const a of admins.values()) if (a.telegramId === telegramId) return a;
      return null;
    },
    async listAdmins() {
      return [...admins.values()];
    },
    async addAdmin(telegramId, fullName) {
      const admin: Admin = { id: makeId(), telegramId, fullName };
      admins.set(admin.id, admin);
      return admin;
    },
    async removeAdmin(id) {
      if (admins.size <= 1) {
        throw new Error("Cannot remove the last remaining admin");
      }
      admins.delete(id);
    },

    async getSchedule() {
      return schedule;
    },

    async listChecklistItems(phase) {
      return [...checklistItems.values()]
        .filter((i) => i.phase === phase)
        .sort((a, b) => a.position - b.position);
    },
    async addChecklistItem(phase, label, requiresPhoto) {
      const existing = await this.listChecklistItems(phase);
      const item: ChecklistItem = {
        id: makeId(),
        phase,
        position: existing.length + 1,
        label,
        requiresPhoto,
      };
      checklistItems.set(item.id, item);
      return item;
    },
    async removeChecklistItem(id) {
      checklistItems.delete(id);
    },

    async listInstructions() {
      return [...instructions.values()].sort((a, b) => a.position - b.position);
    },
    async addInstruction(title, body, mediaUrl) {
      const article: InstructionArticle = {
        id: makeId(),
        position: instructions.size + 1,
        title,
        body,
        mediaUrl,
      };
      instructions.set(article.id, article);
      return article;
    },
    async removeInstruction(id) {
      instructions.delete(id);
    },

    async listExpiryItems() {
      return [...expiryItems.values()].sort((a, b) => a.position - b.position);
    },
    async addExpiryItem(name, shelfLifeDays) {
      const item: ExpiryItem = { id: makeId(), position: expiryItems.size + 1, name, shelfLifeDays };
      expiryItems.set(item.id, item);
      return item;
    },
    async removeExpiryItem(id) {
      expiryItems.delete(id);
    },

    async getShift(employeeId, shiftDate) {
      for (const s of shifts.values()) {
        if (s.employeeId === employeeId && s.shiftDate === shiftDate) return s;
      }
      return null;
    },
    async getShiftById(id) {
      return shifts.get(id) ?? null;
    },
    async createShift(employeeId, shiftDate) {
      const shift: Shift = {
        id: makeId(),
        employeeId,
        shiftDate,
        openedAt: null,
        closedAt: null,
        openCashAmount: null,
        closingFloatAmount: null,
        cashDiscrepancy: null,
        xreportCash: null,
        xreportCashless: null,
        xreportAt: null,
        status: "pending",
        remindedOpenAt: null,
        notifiedLateAt: null,
        remindedCloseAt: null,
        remindedXreportAt: null,
      };
      shifts.set(shift.id, shift);
      return shift;
    },
    async updateShift(id, patch) {
      const current = shifts.get(id);
      if (!current) throw new Error(`Shift not found: ${id}`);
      const updated = { ...current, ...patch };
      shifts.set(id, updated);
      return updated;
    },
    async getPreviousShift(employeeId, beforeDate) {
      const candidates = [...shifts.values()]
        .filter((s) => s.employeeId === employeeId && s.shiftDate < beforeDate)
        .sort((a, b) => (a.shiftDate < b.shiftDate ? 1 : -1));
      return candidates[0] ?? null;
    },
    async listShiftsForDate(shiftDate) {
      return [...shifts.values()].filter((s) => s.shiftDate === shiftDate);
    },

    async getChecklistProgress(shiftId) {
      return [...progress.values()].filter((p) => p.shiftId === shiftId);
    },
    async setChecklistProgress(shiftId, checklistItemId, done, photoFileId = null) {
      progress.set(`${shiftId}:${checklistItemId}`, { shiftId, checklistItemId, done, photoFileId });
    },

    async getSession(telegramId) {
      return sessions.get(telegramId) ?? { state: null, data: {} };
    },
    async setSession(telegramId, state, data = {}) {
      sessions.set(telegramId, { state, data });
    },
    async clearSession(telegramId) {
      sessions.delete(telegramId);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test supabase/functions/_shared/store_test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Implement the Supabase-backed store**

This implementation is not exercised by the automated test suite (no live database in CI for this plan) — it is smoke-tested manually against `supabase start` in Task 14. It must satisfy the exact same `Store` interface.

```ts
// supabase/functions/_shared/supabaseStore.ts
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  Admin, ChecklistItem, ChecklistPhase, ChecklistProgress, Employee,
  ExpiryItem, InstructionArticle, ScheduleDay, SessionState, Shift, Store,
} from "./store.ts";

function toEmployee(row: Record<string, unknown>): Employee {
  return { id: row.id as string, telegramId: Number(row.telegram_id), fullName: row.full_name as string, active: row.active as boolean };
}
function toAdmin(row: Record<string, unknown>): Admin {
  return { id: row.id as string, telegramId: Number(row.telegram_id), fullName: row.full_name as string };
}
function toChecklistItem(row: Record<string, unknown>): ChecklistItem {
  return {
    id: row.id as string, phase: row.phase as ChecklistPhase, position: row.position as number,
    label: row.label as string, requiresPhoto: row.requires_photo as boolean,
  };
}
function toInstruction(row: Record<string, unknown>): InstructionArticle {
  return { id: row.id as string, position: row.position as number, title: row.title as string, body: row.body as string, mediaUrl: (row.media_url as string) ?? null };
}
function toExpiryItem(row: Record<string, unknown>): ExpiryItem {
  return { id: row.id as string, position: row.position as number, name: row.name as string, shelfLifeDays: row.shelf_life_days as number };
}
function toShift(row: Record<string, unknown>): Shift {
  return {
    id: row.id as string, employeeId: row.employee_id as string, shiftDate: row.shift_date as string,
    openedAt: (row.opened_at as string) ?? null, closedAt: (row.closed_at as string) ?? null,
    openCashAmount: row.open_cash_amount === null ? null : Number(row.open_cash_amount),
    closingFloatAmount: row.closing_float_amount === null ? null : Number(row.closing_float_amount),
    cashDiscrepancy: row.cash_discrepancy === null ? null : Number(row.cash_discrepancy),
    xreportCash: row.xreport_cash === null ? null : Number(row.xreport_cash),
    xreportCashless: row.xreport_cashless === null ? null : Number(row.xreport_cashless),
    xreportAt: (row.xreport_at as string) ?? null,
    status: row.status as Shift["status"],
    remindedOpenAt: (row.reminded_open_at as string) ?? null,
    notifiedLateAt: (row.notified_late_at as string) ?? null,
    remindedCloseAt: (row.reminded_close_at as string) ?? null,
    remindedXreportAt: (row.reminded_xreport_at as string) ?? null,
  };
}
function shiftPatchToRow(patch: Partial<Shift>): Record<string, unknown> {
  const map: Record<string, string> = {
    openedAt: "opened_at", closedAt: "closed_at", openCashAmount: "open_cash_amount",
    closingFloatAmount: "closing_float_amount", cashDiscrepancy: "cash_discrepancy",
    xreportCash: "xreport_cash", xreportCashless: "xreport_cashless", xreportAt: "xreport_at",
    status: "status", remindedOpenAt: "reminded_open_at", notifiedLateAt: "notified_late_at",
    remindedCloseAt: "reminded_close_at", remindedXreportAt: "reminded_xreport_at",
  };
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key in map) row[map[key]] = value;
  }
  return row;
}

export function createSupabaseStore(url: string, serviceRoleKey: string): Store {
  const db: SupabaseClient = createClient(url, serviceRoleKey);

  return {
    async getEmployeeByTelegramId(telegramId) {
      const { data, error } = await db.from("employees").select("*").eq("telegram_id", telegramId).maybeSingle();
      if (error) throw error;
      return data ? toEmployee(data) : null;
    },
    async listEmployees() {
      const { data, error } = await db.from("employees").select("*");
      if (error) throw error;
      return (data ?? []).map(toEmployee);
    },
    async addEmployee(telegramId, fullName) {
      const { data, error } = await db.from("employees").insert({ telegram_id: telegramId, full_name: fullName }).select().single();
      if (error) throw error;
      return toEmployee(data);
    },
    async removeEmployee(id) {
      const { error } = await db.from("employees").delete().eq("id", id);
      if (error) throw error;
    },

    async getAdminByTelegramId(telegramId) {
      const { data, error } = await db.from("admins").select("*").eq("telegram_id", telegramId).maybeSingle();
      if (error) throw error;
      return data ? toAdmin(data) : null;
    },
    async listAdmins() {
      const { data, error } = await db.from("admins").select("*");
      if (error) throw error;
      return (data ?? []).map(toAdmin);
    },
    async addAdmin(telegramId, fullName) {
      const { data, error } = await db.from("admins").insert({ telegram_id: telegramId, full_name: fullName }).select().single();
      if (error) throw error;
      return toAdmin(data);
    },
    async removeAdmin(id) {
      const { count, error: countError } = await db.from("admins").select("id", { count: "exact", head: true });
      if (countError) throw countError;
      if ((count ?? 0) <= 1) throw new Error("Cannot remove the last remaining admin");
      const { error } = await db.from("admins").delete().eq("id", id);
      if (error) throw error;
    },

    async getSchedule() {
      const { data, error } = await db.from("schedule").select("*").order("weekday");
      if (error) throw error;
      return (data ?? []).map((r): ScheduleDay => ({ weekday: r.weekday, opensAt: r.opens_at, closesAt: r.closes_at }));
    },

    async listChecklistItems(phase) {
      const { data, error } = await db.from("checklist_items").select("*").eq("phase", phase).order("position");
      if (error) throw error;
      return (data ?? []).map(toChecklistItem);
    },
    async addChecklistItem(phase, label, requiresPhoto) {
      const existing = await this.listChecklistItems(phase);
      const { data, error } = await db
        .from("checklist_items")
        .insert({ phase, label, requires_photo: requiresPhoto, position: existing.length + 1 })
        .select().single();
      if (error) throw error;
      return toChecklistItem(data);
    },
    async removeChecklistItem(id) {
      const { error } = await db.from("checklist_items").delete().eq("id", id);
      if (error) throw error;
    },

    async listInstructions() {
      const { data, error } = await db.from("instructions").select("*").order("position");
      if (error) throw error;
      return (data ?? []).map(toInstruction);
    },
    async addInstruction(title, body, mediaUrl) {
      const existing = await this.listInstructions();
      const { data, error } = await db
        .from("instructions")
        .insert({ title, body, media_url: mediaUrl, position: existing.length + 1 })
        .select().single();
      if (error) throw error;
      return toInstruction(data);
    },
    async removeInstruction(id) {
      const { error } = await db.from("instructions").delete().eq("id", id);
      if (error) throw error;
    },

    async listExpiryItems() {
      const { data, error } = await db.from("expiry_items").select("*").order("position");
      if (error) throw error;
      return (data ?? []).map(toExpiryItem);
    },
    async addExpiryItem(name, shelfLifeDays) {
      const existing = await this.listExpiryItems();
      const { data, error } = await db
        .from("expiry_items")
        .insert({ name, shelf_life_days: shelfLifeDays, position: existing.length + 1 })
        .select().single();
      if (error) throw error;
      return toExpiryItem(data);
    },
    async removeExpiryItem(id) {
      const { error } = await db.from("expiry_items").delete().eq("id", id);
      if (error) throw error;
    },

    async getShift(employeeId, shiftDate) {
      const { data, error } = await db.from("shifts").select("*").eq("employee_id", employeeId).eq("shift_date", shiftDate).maybeSingle();
      if (error) throw error;
      return data ? toShift(data) : null;
    },
    async getShiftById(id) {
      const { data, error } = await db.from("shifts").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return data ? toShift(data) : null;
    },
    async createShift(employeeId, shiftDate) {
      const { data, error } = await db.from("shifts").insert({ employee_id: employeeId, shift_date: shiftDate }).select().single();
      if (error) throw error;
      return toShift(data);
    },
    async updateShift(id, patch) {
      const { data, error } = await db.from("shifts").update(shiftPatchToRow(patch)).eq("id", id).select().single();
      if (error) throw error;
      return toShift(data);
    },
    async getPreviousShift(employeeId, beforeDate) {
      const { data, error } = await db
        .from("shifts").select("*").eq("employee_id", employeeId).lt("shift_date", beforeDate)
        .order("shift_date", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data ? toShift(data) : null;
    },
    async listShiftsForDate(shiftDate) {
      const { data, error } = await db.from("shifts").select("*").eq("shift_date", shiftDate);
      if (error) throw error;
      return (data ?? []).map(toShift);
    },

    async getChecklistProgress(shiftId) {
      const { data, error } = await db.from("shift_checklist_progress").select("*").eq("shift_id", shiftId);
      if (error) throw error;
      return (data ?? []).map((r): ChecklistProgress => ({
        shiftId: r.shift_id, checklistItemId: r.checklist_item_id, done: r.done, photoFileId: r.photo_file_id ?? null,
      }));
    },
    async setChecklistProgress(shiftId, checklistItemId, done, photoFileId = null) {
      const { error } = await db
        .from("shift_checklist_progress")
        .upsert({ shift_id: shiftId, checklist_item_id: checklistItemId, done, photo_file_id: photoFileId }, { onConflict: "shift_id,checklist_item_id" });
      if (error) throw error;
    },

    async getSession(telegramId) {
      const { data, error } = await db.from("bot_sessions").select("state, data").eq("telegram_id", telegramId).maybeSingle();
      if (error) throw error;
      return data ? { state: data.state, data: data.data } : { state: null, data: {} };
    },
    async setSession(telegramId, state, data = {}) {
      const { error } = await db
        .from("bot_sessions")
        .upsert({ telegram_id: telegramId, state, data, updated_at: new Date().toISOString() });
      if (error) throw error;
    },
    async clearSession(telegramId) {
      await this.setSession(telegramId, null, {});
    },
  };
}
```

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/store.ts supabase/functions/_shared/store_test.ts supabase/functions/_shared/supabaseStore.ts
git commit -m "Add Store interface with in-memory and Supabase implementations"
```

---

### Task 4: Webhook dispatcher skeleton

Sets up the routing skeleton every later handler task plugs into, plus the secret-token check as its own pure, testable function.

**Files:**
- Create: `supabase/functions/_shared/auth.ts`
- Create: `supabase/functions/telegram-webhook/router.ts` (`handleMessage`)
- Create: `supabase/functions/telegram-webhook/callbackRouter.ts` (`handleCallbackQuery`)
- Create: `supabase/functions/telegram-webhook/handleUpdate.ts`
- Create: `supabase/functions/telegram-webhook/index.ts`
- Test: `supabase/functions/_shared/auth_test.ts`
- Test: `supabase/functions/telegram-webhook/handleUpdate_test.ts`

**Interfaces:**
- Consumes: `Store`, `createInMemoryStore` from Task 3; `TelegramClient`, `TelegramUpdate`, `TelegramMessage`, `TelegramCallbackQuery` from Task 2.
- Produces: `handleUpdate(store: Store, telegram: TelegramClient, update: TelegramUpdate): Promise<void>` — the function every later handler task's tests call to drive the bot end-to-end; `isAuthorized(req: Request, secret: string | undefined): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/_shared/auth_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isAuthorized } from "./auth.ts";

Deno.test("isAuthorized allows the request when the secret header matches", () => {
  const req = new Request("https://example.com", { headers: { "x-telegram-bot-api-secret-token": "s3cret" } });
  assertEquals(isAuthorized(req, "s3cret"), true);
});

Deno.test("isAuthorized rejects the request when the secret header is missing or wrong", () => {
  const noHeader = new Request("https://example.com");
  assertEquals(isAuthorized(noHeader, "s3cret"), false);

  const wrongHeader = new Request("https://example.com", { headers: { "x-telegram-bot-api-secret-token": "nope" } });
  assertEquals(isAuthorized(wrongHeader, "s3cret"), false);
});

Deno.test("isAuthorized allows any request when no secret is configured", () => {
  const req = new Request("https://example.com");
  assertEquals(isAuthorized(req, undefined), true);
});
```

```ts
// supabase/functions/telegram-webhook/handleUpdate_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../_shared/store.ts";
import type { TelegramClient, TelegramUpdate } from "../_shared/telegram.ts";
import { handleUpdate } from "./handleUpdate.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string }[] = [];
  const answered: { id: string; text?: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); },
    async sendPhoto() {},
    async answerCallbackQuery(id, text) { answered.push({ id, text }); },
    async editMessageReplyMarkup() {},
    async setWebhook() {},
  };
  return { client, sent, answered };
}

Deno.test("an unrecognized text message gets a fallback reply", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();
  const update: TelegramUpdate = {
    update_id: 1,
    message: { message_id: 1, from: { id: 1, first_name: "Аня" }, chat: { id: 1 }, text: "asdf" },
  };

  await handleUpdate(store, client, update);

  assertEquals(sent.length, 1);
  assertEquals(sent[0].chatId, 1);
});

Deno.test("an unrecognized callback query is answered with no visible text", async () => {
  const store = createInMemoryStore();
  const { client, answered } = fakeTelegram();
  const update: TelegramUpdate = {
    update_id: 2,
    callback_query: { id: "cbq-1", from: { id: 1, first_name: "Аня" }, message: { chat: { id: 1 }, message_id: 5 }, data: "unknown:thing" },
  };

  await handleUpdate(store, client, update);

  assertEquals(answered, [{ id: "cbq-1", text: undefined }]);
});

Deno.test("an update with neither message nor callback_query is a no-op", async () => {
  const store = createInMemoryStore();
  const { client, sent, answered } = fakeTelegram();

  await handleUpdate(store, client, { update_id: 3 });

  assertEquals(sent.length, 0);
  assertEquals(answered.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test supabase/functions/_shared/auth_test.ts supabase/functions/telegram-webhook/handleUpdate_test.ts`
Expected: FAIL — the source files don't exist yet.

- [ ] **Step 3: Implement `auth.ts`**

```ts
// supabase/functions/_shared/auth.ts
export function isAuthorized(req: Request, secret: string | undefined): boolean {
  if (!secret) return true;
  return req.headers.get("x-telegram-bot-api-secret-token") === secret;
}
```

- [ ] **Step 4: Implement the router, callback router, and `handleUpdate`**

```ts
// supabase/functions/telegram-webhook/router.ts
import type { Store } from "../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../_shared/telegram.ts";

export async function handleMessage(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  await telegram.sendMessage(message.chat.id, "Не понимаю эту команду. Используйте кнопки внизу экрана.");
}
```

```ts
// supabase/functions/telegram-webhook/callbackRouter.ts
import type { Store } from "../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient } from "../_shared/telegram.ts";

export async function handleCallbackQuery(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  await telegram.answerCallbackQuery(callbackQuery.id);
}
```

```ts
// supabase/functions/telegram-webhook/handleUpdate.ts
import type { Store } from "../_shared/store.ts";
import type { TelegramClient, TelegramUpdate } from "../_shared/telegram.ts";
import { handleMessage } from "./router.ts";
import { handleCallbackQuery } from "./callbackRouter.ts";

export async function handleUpdate(
  store: Store,
  telegram: TelegramClient,
  update: TelegramUpdate,
): Promise<void> {
  if (update.message) {
    await handleMessage(store, telegram, update.message);
  } else if (update.callback_query) {
    await handleCallbackQuery(store, telegram, update.callback_query);
  }
}
```

```ts
// supabase/functions/telegram-webhook/index.ts
import { createSupabaseStore } from "../_shared/supabaseStore.ts";
import { createTelegramClient } from "../_shared/telegram.ts";
import { isAuthorized } from "../_shared/auth.ts";
import type { TelegramUpdate } from "../_shared/telegram.ts";
import { handleUpdate } from "./handleUpdate.ts";

Deno.serve(async (req) => {
  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (!isAuthorized(req, secret)) {
    return new Response("forbidden", { status: 403 });
  }

  const update = (await req.json()) as TelegramUpdate;
  const store = createSupabaseStore(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const telegram = createTelegramClient(Deno.env.get("TELEGRAM_BOT_TOKEN")!);

  try {
    await handleUpdate(store, telegram, update);
  } catch (err) {
    console.error("handleUpdate failed", err);
  }
  return new Response("ok", { status: 200 });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno test supabase/functions/_shared/auth_test.ts supabase/functions/telegram-webhook/handleUpdate_test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/auth.ts supabase/functions/_shared/auth_test.ts supabase/functions/telegram-webhook/
git commit -m "Add webhook dispatcher skeleton with secret-token auth"
```

---

### Task 5: Venue clock helper, `/start`, and the persistent employee panel

**Files:**
- Create: `supabase/functions/_shared/time.ts`
- Test: `supabase/functions/_shared/time_test.ts`
- Create: `supabase/functions/telegram-webhook/keyboards.ts`
- Create: `supabase/functions/telegram-webhook/handlers/start.ts`
- Test: `supabase/functions/telegram-webhook/handlers/start_test.ts`
- Modify: `supabase/functions/telegram-webhook/router.ts`

**Interfaces:**
- Consumes: `Store`, `Shift` from Task 3; `TelegramClient`, `TelegramMessage`, `ReplyKeyboard` from Task 2; `handleMessage` signature from Task 4.
- Produces: `todayDateKey(now?: Date): string`, `todayWeekday(now?: Date): number` (used from Task 6 onward for shift-date lookups and schedule comparisons); `renderEmployeeKeyboard(shift: Shift | null): ReplyKeyboard` (used from Task 6-7 once shift status changes); `handleStart(store, telegram, message): Promise<void>`.

- [ ] **Step 1: Write the failing test for the clock helper**

```ts
// supabase/functions/_shared/time_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dateKeyInTimezone, weekdayInTimezone, VENUE_TZ_OFFSET_MINUTES } from "./time.ts";

Deno.test("dateKeyInTimezone shows the venue's local date even just after UTC midnight", () => {
  // 2026-09-25 00:30 UTC = 2026-09-25 03:30 Moscow (UTC+3) — still the 25th locally either way,
  // so use a time where UTC and Moscow disagree on the calendar day.
  const lateUtc = new Date("2026-09-24T22:00:00.000Z"); // 2026-09-25 01:00 Moscow
  assertEquals(dateKeyInTimezone(lateUtc, VENUE_TZ_OFFSET_MINUTES), "2026-09-25");
});

Deno.test("weekdayInTimezone maps Monday to 0 and Sunday to 6", () => {
  const monday = new Date("2026-09-21T10:00:00.000Z"); // a Monday
  const sunday = new Date("2026-09-27T10:00:00.000Z"); // the following Sunday
  assertEquals(weekdayInTimezone(monday, VENUE_TZ_OFFSET_MINUTES), 0);
  assertEquals(weekdayInTimezone(sunday, VENUE_TZ_OFFSET_MINUTES), 6);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno test supabase/functions/_shared/time_test.ts`
Expected: FAIL — `time.ts` does not exist yet.

- [ ] **Step 3: Implement the clock helper**

```ts
// supabase/functions/_shared/time.ts

// The venue is in Moscow (UTC+3, no DST) — hardcoded because this bot serves one location (spec §2).
export const VENUE_TZ_OFFSET_MINUTES = 180;

export function dateKeyInTimezone(date: Date, tzOffsetMinutes: number): string {
  const shifted = new Date(date.getTime() + tzOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function weekdayInTimezone(date: Date, tzOffsetMinutes: number): number {
  const shifted = new Date(date.getTime() + tzOffsetMinutes * 60_000);
  const jsDay = shifted.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  return (jsDay + 6) % 7; // remapped to 0 = Monday .. 6 = Sunday, matching the `schedule` table
}

export function todayDateKey(now: Date = new Date()): string {
  return dateKeyInTimezone(now, VENUE_TZ_OFFSET_MINUTES);
}

export function todayWeekday(now: Date = new Date()): number {
  return weekdayInTimezone(now, VENUE_TZ_OFFSET_MINUTES);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `deno test supabase/functions/_shared/time_test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test for `/start`**

```ts
// supabase/functions/telegram-webhook/handlers/start_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { handleStart } from "./start.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); },
    async sendPhoto() {},
    async answerCallbackQuery() {},
    async editMessageReplyMarkup() {},
    async setWebhook() {},
  };
  return { client, sent };
}

function startMessage(fromId: number): TelegramMessage {
  return { message_id: 1, from: { id: fromId, first_name: "Тест" }, chat: { id: fromId }, text: "/start" };
}

Deno.test("an unregistered user is told to contact the admin, with no keyboard", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleStart(store, client, startMessage(999));

  assertEquals(sent.length, 1);
  assertEquals(sent[0].text.includes("не зарегистрированы"), true);
  assertEquals(sent[0].replyMarkup, undefined);
});

Deno.test("a registered employee with no shift today gets the OPEN panel", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await handleStart(store, client, startMessage(1));

  assertEquals(sent[0].replyMarkup, {
    keyboard: [["🟢 OPEN"], ["🧾 Контрольный X-отчёт"], ["📖 Инструкции", "🍰 Сроки годности"]],
    resize_keyboard: true,
  });
});

Deno.test("a registered employee with an open shift today gets the CLOSER panel", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await handleStart(store, client, startMessage(1));

  assertEquals((sent[0].replyMarkup as { keyboard: string[][] }).keyboard[0], ["🔴 CLOSER"]);
});

Deno.test("an admin who is not also an employee gets pointed at /admin, with no shift panel", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(1, "RCA");
  const { client, sent } = fakeTelegram();

  await handleStart(store, client, startMessage(1));

  assertEquals(sent[0].text.includes("/admin"), true);
  assertEquals(sent[0].replyMarkup, undefined);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `deno test supabase/functions/telegram-webhook/handlers/start_test.ts`
Expected: FAIL — `start.ts` and `keyboards.ts` don't exist yet.

- [ ] **Step 7: Implement `keyboards.ts` and `start.ts`**

```ts
// supabase/functions/telegram-webhook/keyboards.ts
import type { ReplyKeyboard } from "../_shared/telegram.ts";
import type { Shift } from "../_shared/store.ts";

export function renderEmployeeKeyboard(shift: Shift | null): ReplyKeyboard {
  const topRow = shift?.status === "open" ? ["🔴 CLOSER"] : ["🟢 OPEN"];
  return {
    keyboard: [topRow, ["🧾 Контрольный X-отчёт"], ["📖 Инструкции", "🍰 Сроки годности"]],
    resize_keyboard: true,
  };
}
```

```ts
// supabase/functions/telegram-webhook/handlers/start.ts
import type { Store } from "../../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { todayDateKey } from "../../_shared/time.ts";
import { renderEmployeeKeyboard } from "../keyboards.ts";

export async function handleStart(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const telegramId = message.from.id;

  const employee = await store.getEmployeeByTelegramId(telegramId);
  if (employee) {
    const shift = await store.getShift(employee.id, todayDateKey());
    await telegram.sendMessage(message.chat.id, `С возвращением, ${employee.fullName} 👋`, {
      replyMarkup: renderEmployeeKeyboard(shift),
    });
    return;
  }

  const admin = await store.getAdminByTelegramId(telegramId);
  if (admin) {
    await telegram.sendMessage(
      message.chat.id,
      `Здравствуйте, ${admin.fullName}. Используйте /admin для управления ботом.`,
    );
    return;
  }

  await telegram.sendMessage(
    message.chat.id,
    "Вы не зарегистрированы в этом боте. Обратитесь к администратору заведения.",
  );
}
```

- [ ] **Step 8: Wire `/start` into the router**

```ts
// supabase/functions/telegram-webhook/router.ts
import type { Store } from "../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../_shared/telegram.ts";
import { handleStart } from "./handlers/start.ts";

export async function handleMessage(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  if (message.text === "/start") {
    await handleStart(store, telegram, message);
    return;
  }

  await telegram.sendMessage(message.chat.id, "Не понимаю эту команду. Используйте кнопки внизу экрана.");
}
```

- [ ] **Step 9: Run both test files to verify everything passes**

Run: `deno test supabase/functions/_shared/time_test.ts supabase/functions/telegram-webhook/handlers/start_test.ts supabase/functions/telegram-webhook/handleUpdate_test.ts`
Expected: PASS — including the Task 4 `handleUpdate_test.ts`, since `/start` is now handled but the unrecognized-text case must still fall through unchanged.

- [ ] **Step 10: Commit**

```bash
git add supabase/functions/_shared/time.ts supabase/functions/_shared/time_test.ts supabase/functions/telegram-webhook/keyboards.ts supabase/functions/telegram-webhook/handlers/start.ts supabase/functions/telegram-webhook/handlers/start_test.ts supabase/functions/telegram-webhook/router.ts
git commit -m "Add /start handler and persistent employee panel keyboard"
```

---

### Task 6: Open-shift flow (checklist, размен, discrepancy warning)

**Files:**
- Modify: `supabase/functions/_shared/time.ts` (add `formatVenueTime`)
- Modify: `supabase/functions/_shared/time_test.ts`
- Create: `supabase/functions/_shared/notify.ts`
- Test: `supabase/functions/_shared/notify_test.ts`
- Create: `supabase/functions/telegram-webhook/checklist.ts`
- Test: `supabase/functions/telegram-webhook/checklist_test.ts`
- Create: `supabase/functions/telegram-webhook/handlers/open.ts`
- Test: `supabase/functions/telegram-webhook/handlers/open_test.ts`
- Modify: `supabase/functions/telegram-webhook/router.ts`
- Modify: `supabase/functions/telegram-webhook/callbackRouter.ts`
- Modify: `supabase/functions/telegram-webhook/handleUpdate_test.ts`

**Interfaces:**
- Consumes: `Store`, `Shift`, `ChecklistItem`, `ChecklistProgress` from Task 3; `TelegramClient` (incl. `editMessageReplyMarkup`), `InlineKeyboard`, `TelegramCallbackQuery`, `TelegramMessage` from Task 2; `todayDateKey` from Task 5; `renderEmployeeKeyboard` from Task 5.
- Produces: `notifyAdmins(store, telegram, text): Promise<void>` (used by Tasks 7–9); `renderChecklistKeyboard(items, progress): InlineKeyboard` and `isChecklistComplete(items, progress): boolean` (reused as-is by Task 7 for the closing checklist); `handleOpenButton`, `handleOpenChecklistToggle`, `handleOpenCashAmount` — the session state string `"awaiting_open_cash"` with `data: { shiftId: string }` that Task 7 must not collide with.

- [ ] **Step 1: Write the failing test for `formatVenueTime`**

```ts
// append to supabase/functions/_shared/time_test.ts
import { formatVenueTime } from "./time.ts"; // add to the existing import line instead if one exists

Deno.test("formatVenueTime renders the venue-local HH:MM for a UTC timestamp", () => {
  assertEquals(formatVenueTime("2026-09-25T05:31:00.000Z"), "08:31"); // UTC+3
});
```

- [ ] **Step 2: Run it, confirm it fails, then implement `formatVenueTime`**

```ts
// append to supabase/functions/_shared/time.ts
export function formatVenueTime(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + VENUE_TZ_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(11, 16);
}
```

Run: `deno test supabase/functions/_shared/time_test.ts` — Expected: PASS.

- [ ] **Step 3: Write the failing test for `notifyAdmins`**

```ts
// supabase/functions/_shared/notify_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "./store.ts";
import type { TelegramClient } from "./telegram.ts";
import { notifyAdmins } from "./notify.ts";

Deno.test("notifyAdmins sends the same text to every admin", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(100, "RCA");
  await store.addAdmin(200, "Мария");
  const sent: number[] = [];
  const telegram: TelegramClient = {
    async sendMessage(chatId) { sent.push(chatId); },
    async sendPhoto() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };

  await notifyAdmins(store, telegram, "hello");

  assertEquals(sent.sort(), [100, 200]);
});

Deno.test("notifyAdmins is a no-op when there are no admins yet", async () => {
  const store = createInMemoryStore();
  const sent: number[] = [];
  const telegram: TelegramClient = {
    async sendMessage(chatId) { sent.push(chatId); },
    async sendPhoto() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };

  await notifyAdmins(store, telegram, "hello");

  assertEquals(sent, []);
});
```

- [ ] **Step 4: Run it, confirm it fails, then implement `notify.ts`**

```ts
// supabase/functions/_shared/notify.ts
import type { Store } from "./store.ts";
import type { TelegramClient } from "./telegram.ts";

export async function notifyAdmins(store: Store, telegram: TelegramClient, text: string): Promise<void> {
  const admins = await store.listAdmins();
  for (const admin of admins) {
    await telegram.sendMessage(admin.telegramId, text);
  }
}
```

Run: `deno test supabase/functions/_shared/notify_test.ts` — Expected: PASS.

- [ ] **Step 5: Write the failing tests for the checklist keyboard helpers**

```ts
// supabase/functions/telegram-webhook/checklist_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isChecklistComplete, renderChecklistKeyboard } from "./checklist.ts";
import type { ChecklistItem, ChecklistProgress } from "../_shared/store.ts";

const items: ChecklistItem[] = [
  { id: "a", phase: "open", position: 1, label: "Кофемашина прогрета", requiresPhoto: false },
  { id: "b", phase: "close", position: 1, label: "Фото отчёта с кассы", requiresPhoto: true },
];

Deno.test("renderChecklistKeyboard marks done items with a checkmark and photo items with a camera", () => {
  const progress: ChecklistProgress[] = [{ shiftId: "s", checklistItemId: "a", done: true, photoFileId: null }];

  const keyboard = renderChecklistKeyboard(items, progress);

  assertEquals(keyboard.inline_keyboard[0][0].text, "✅ Кофемашина прогрета");
  assertEquals(keyboard.inline_keyboard[1][0].text, "📷 Фото отчёта с кассы");
  assertEquals(keyboard.inline_keyboard[1][0].callback_data, "chk:close:b");
});

Deno.test("isChecklistComplete is false until every item is done, then true", () => {
  const partial: ChecklistProgress[] = [{ shiftId: "s", checklistItemId: "a", done: true, photoFileId: null }];
  assertEquals(isChecklistComplete(items, partial), false);

  const full: ChecklistProgress[] = [
    { shiftId: "s", checklistItemId: "a", done: true, photoFileId: null },
    { shiftId: "s", checklistItemId: "b", done: true, photoFileId: "file123" },
  ];
  assertEquals(isChecklistComplete(items, full), true);
});

Deno.test("isChecklistComplete is false for an empty checklist (nothing to confirm)", () => {
  assertEquals(isChecklistComplete([], []), false);
});
```

- [ ] **Step 6: Run it, confirm it fails, then implement `checklist.ts`**

```ts
// supabase/functions/telegram-webhook/checklist.ts
import type { ChecklistItem, ChecklistProgress } from "../_shared/store.ts";
import type { InlineKeyboard } from "../_shared/telegram.ts";

export function renderChecklistKeyboard(items: ChecklistItem[], progress: ChecklistProgress[]): InlineKeyboard {
  const doneIds = new Set(progress.filter((p) => p.done).map((p) => p.checklistItemId));
  return {
    inline_keyboard: items.map((item) => {
      const done = doneIds.has(item.id);
      const prefix = done ? "✅" : item.requiresPhoto ? "📷" : "☐";
      return [{ text: `${prefix} ${item.label}`, callback_data: `chk:${item.phase}:${item.id}` }];
    }),
  };
}

export function isChecklistComplete(items: ChecklistItem[], progress: ChecklistProgress[]): boolean {
  if (items.length === 0) return false;
  const doneIds = new Set(progress.filter((p) => p.done).map((p) => p.checklistItemId));
  return items.every((item) => doneIds.has(item.id));
}
```

Run: `deno test supabase/functions/telegram-webhook/checklist_test.ts` — Expected: PASS.

- [ ] **Step 7: Write the failing tests for the open-shift handlers**

```ts
// supabase/functions/telegram-webhook/handlers/open_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { handleOpenButton, handleOpenCashAmount, handleOpenChecklistToggle } from "./open.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const edited: { chatId: number; messageId: number; markup: unknown }[] = [];
  const answered: { id: string; text?: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); },
    async sendPhoto() {},
    async answerCallbackQuery(id, text) { answered.push({ id, text }); },
    async editMessageReplyMarkup(chatId, messageId, markup) { edited.push({ chatId, messageId, markup }); },
    async setWebhook() {},
  };
  return { client, sent, edited, answered };
}

function openMessage(fromId: number, text: string): TelegramMessage {
  return { message_id: 1, from: { id: fromId, first_name: "Анна" }, chat: { id: fromId }, text };
}

function toggleCallback(fromId: number, itemId: string): TelegramCallbackQuery {
  return { id: "cbq", from: { id: fromId, first_name: "Анна" }, message: { chat: { id: fromId }, message_id: 7 }, data: `chk:open:${itemId}` };
}

Deno.test("OPEN with an already-open shift today tells the employee instead of restarting the checklist", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await handleOpenButton(store, client, openMessage(1, "🟢 OPEN"));

  assertEquals(sent, [{ chatId: 1, text: "Смена уже открыта.", replyMarkup: undefined }]);
});

Deno.test("OPEN with an already-closed shift today refuses to reopen it", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "closed" });
  const { client, sent } = fakeTelegram();

  await handleOpenButton(store, client, openMessage(1, "🟢 OPEN"));

  assertEquals(sent, [{ chatId: 1, text: "Смена на сегодня уже закрыта.", replyMarkup: undefined }]);
});

Deno.test("OPEN with no shift yet creates one and shows the checklist", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  await store.addChecklistItem("open", "Кофемашина прогрета", false);
  const { client, sent } = fakeTelegram();

  await handleOpenButton(store, client, openMessage(1, "🟢 OPEN"));

  assertEquals(sent.length, 1);
  assertEquals((sent[0].replyMarkup as { inline_keyboard: unknown[] }).inline_keyboard.length, 1);
  const shift = await store.getShift(employee.id, "2026-09-25");
  assertEquals(shift?.status, "pending");
});

Deno.test("toggling the last open-checklist item edits the message and prompts for the cash amount", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  const item = await store.addChecklistItem("open", "Зал чистый", false);
  const { client, edited, sent, answered } = fakeTelegram();

  await handleOpenChecklistToggle(store, client, toggleCallback(1, item.id), item.id);

  assertEquals(edited.length, 1);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
  assertEquals(sent, [{ chatId: 1, text: "Чек-лист пройден. Введите сумму наличных в кассе (размен).", replyMarkup: undefined }]);

  const session = await store.getSession(1);
  assertEquals(session, { state: "awaiting_open_cash", data: { shiftId: shift.id } });
});

Deno.test("toggling before OPEN was pressed tells the employee to open first, without creating progress", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const item = await store.addChecklistItem("open", "Зал чистый", false);
  const { client, answered, edited } = fakeTelegram();

  await handleOpenChecklistToggle(store, client, toggleCallback(1, item.id), item.id);

  assertEquals(answered, [{ id: "cbq", text: "Сначала нажмите OPEN." }]);
  assertEquals(edited, []);
});

Deno.test("a non-numeric cash amount gets a re-prompt and does not open the shift", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  const { client, sent } = fakeTelegram();

  await handleOpenCashAmount(store, client, openMessage(1, "три тысячи"), shift.id);

  assertEquals(sent, [{ chatId: 1, text: "Не понял сумму. Введите число, например 3000.", replyMarkup: undefined }]);
  assertEquals((await store.getShiftById(shift.id))?.status, "pending");
});

Deno.test("a matching cash amount opens the shift with no discrepancy warning", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const yesterday = await store.createShift(employee.id, "2026-09-24");
  await store.updateShift(yesterday.id, { closingFloatAmount: 3000 });
  const shift = await store.createShift(employee.id, "2026-09-25");
  const { client, sent } = fakeTelegram();

  await handleOpenCashAmount(store, client, openMessage(1, "3000"), shift.id);

  const updated = await store.getShiftById(shift.id);
  assertEquals(updated?.status, "open");
  assertEquals(updated?.cashDiscrepancy, 0);
  assertEquals(sent.some((m) => m.text.includes("⚠️")), false);
});

Deno.test("a mismatched cash amount warns the employee and notifies every admin", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const employee = await store.addEmployee(1, "Анна");
  const yesterday = await store.createShift(employee.id, "2026-09-24");
  await store.updateShift(yesterday.id, { closingFloatAmount: 3500 });
  const shift = await store.createShift(employee.id, "2026-09-25");
  const { client, sent } = fakeTelegram();

  await handleOpenCashAmount(store, client, openMessage(1, "3000"), shift.id);

  const toEmployee = sent.filter((m) => m.chatId === 1);
  const toAdmin = sent.filter((m) => m.chatId === 999);
  assertEquals(toEmployee.some((m) => m.text.includes("⚠️")), true);
  assertEquals(toAdmin.some((m) => m.text.includes("Расхождение размена")), true);
});

Deno.test("the first-ever shift for an employee opens cleanly with no previous shift to compare against", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  const { client, sent } = fakeTelegram();

  await handleOpenCashAmount(store, client, openMessage(1, "3000"), shift.id);

  const updated = await store.getShiftById(shift.id);
  assertEquals(updated?.status, "open");
  assertEquals(updated?.cashDiscrepancy, null);
  assertEquals(sent.some((m) => m.text.includes("⚠️")), false);
});
```

- [ ] **Step 8: Run the tests to verify they fail**

Run: `deno test supabase/functions/telegram-webhook/handlers/open_test.ts`
Expected: FAIL — `open.ts` does not exist yet.

- [ ] **Step 9: Implement `handlers/open.ts`**

```ts
// supabase/functions/telegram-webhook/handlers/open.ts
import type { Store } from "../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { formatVenueTime, todayDateKey } from "../../_shared/time.ts";
import { notifyAdmins } from "../../_shared/notify.ts";
import { isChecklistComplete, renderChecklistKeyboard } from "../checklist.ts";
import { renderEmployeeKeyboard } from "../keyboards.ts";

export async function handleOpenButton(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(message.from.id);
  if (!employee) return;

  const today = todayDateKey();
  const existing = await store.getShift(employee.id, today);

  if (existing?.status === "open") {
    await telegram.sendMessage(message.chat.id, "Смена уже открыта.");
    return;
  }
  if (existing?.status === "closed") {
    await telegram.sendMessage(message.chat.id, "Смена на сегодня уже закрыта.");
    return;
  }

  const shift = existing ?? (await store.createShift(employee.id, today));
  const items = await store.listChecklistItems("open");
  const progress = await store.getChecklistProgress(shift.id);

  await telegram.sendMessage(message.chat.id, "Перед открытием отметьте пункты:", {
    replyMarkup: renderChecklistKeyboard(items, progress),
  });
}

export async function handleOpenChecklistToggle(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  itemId: string,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(callbackQuery.from.id);
  if (!employee) { await telegram.answerCallbackQuery(callbackQuery.id); return; }

  const today = todayDateKey();
  const shift = await store.getShift(employee.id, today);
  if (!shift || shift.status !== "pending") {
    await telegram.answerCallbackQuery(callbackQuery.id, "Сначала нажмите OPEN.");
    return;
  }

  const items = await store.listChecklistItems("open");
  const item = items.find((i) => i.id === itemId);
  if (!item) { await telegram.answerCallbackQuery(callbackQuery.id); return; }

  await store.setChecklistProgress(shift.id, item.id, true);
  const progress = await store.getChecklistProgress(shift.id);

  await telegram.editMessageReplyMarkup(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    renderChecklistKeyboard(items, progress),
  );
  await telegram.answerCallbackQuery(callbackQuery.id);

  if (isChecklistComplete(items, progress)) {
    await store.setSession(callbackQuery.from.id, "awaiting_open_cash", { shiftId: shift.id });
    await telegram.sendMessage(
      callbackQuery.message.chat.id,
      "Чек-лист пройден. Введите сумму наличных в кассе (размен).",
    );
  }
}

export async function handleOpenCashAmount(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
  shiftId: string,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(message.from.id);
  if (!employee) return;

  const amount = Number((message.text ?? "").replace(",", ".").trim());
  if (!message.text || Number.isNaN(amount) || amount < 0) {
    await telegram.sendMessage(message.chat.id, "Не понял сумму. Введите число, например 3000.");
    return;
  }

  const shift = await store.getShiftById(shiftId);
  if (!shift) return;

  const previous = await store.getPreviousShift(employee.id, shift.shiftDate);
  const expected = previous?.closingFloatAmount ?? null;
  const discrepancy = expected === null ? null : Math.round((amount - expected) * 100) / 100;

  const updated = await store.updateShift(shift.id, {
    openCashAmount: amount,
    cashDiscrepancy: discrepancy,
    openedAt: new Date().toISOString(),
    status: "open",
  });

  await store.clearSession(message.from.id);

  if (discrepancy !== null && discrepancy !== 0) {
    await telegram.sendMessage(
      message.chat.id,
      `⚠️ Вчера смена закрылась с ${expected} ₽. Расхождение ${Math.abs(discrepancy)} ₽. Админ уведомлён.`,
    );
    await notifyAdmins(
      store,
      telegram,
      `⚠️ Расхождение размена у ${employee.fullName}: заявлено ${amount} ₽, ожидалось ${expected} ₽ (${discrepancy > 0 ? "+" : ""}${discrepancy} ₽).`,
    );
  }

  await telegram.sendMessage(message.chat.id, "Смена открыта ✅", {
    replyMarkup: renderEmployeeKeyboard(updated),
  });
  await notifyAdmins(
    store,
    telegram,
    `🟢 ${employee.fullName} открыла смену в ${formatVenueTime(updated.openedAt!)}.`,
  );
}
```

- [ ] **Step 10: Wire OPEN into the message router and the checklist callback into the callback router**

```ts
// supabase/functions/telegram-webhook/router.ts
import type { Store } from "../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../_shared/telegram.ts";
import { handleStart } from "./handlers/start.ts";
import { handleOpenButton, handleOpenCashAmount } from "./handlers/open.ts";

export async function handleMessage(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const session = await store.getSession(message.from.id);

  if (session.state === "awaiting_open_cash") {
    await handleOpenCashAmount(store, telegram, message, session.data.shiftId as string);
    return;
  }

  if (message.text === "/start") {
    await handleStart(store, telegram, message);
    return;
  }

  if (message.text === "🟢 OPEN") {
    await handleOpenButton(store, telegram, message);
    return;
  }

  await telegram.sendMessage(message.chat.id, "Не понимаю эту команду. Используйте кнопки внизу экрана.");
}
```

```ts
// supabase/functions/telegram-webhook/callbackRouter.ts
import type { Store } from "../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient } from "../_shared/telegram.ts";
import { handleOpenChecklistToggle } from "./handlers/open.ts";

export async function handleCallbackQuery(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const [kind, phase, itemId] = callbackQuery.data.split(":");

  if (kind === "chk" && phase === "open" && itemId) {
    await handleOpenChecklistToggle(store, telegram, callbackQuery, itemId);
    return;
  }

  await telegram.answerCallbackQuery(callbackQuery.id);
}
```

- [ ] **Step 11: Add one router-level regression check**

```ts
// append to supabase/functions/telegram-webhook/handleUpdate_test.ts
Deno.test("the OPEN button is routed to the open-shift handler, not the fallback reply", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();
  const update: TelegramUpdate = {
    update_id: 4,
    message: { message_id: 1, from: { id: 1, first_name: "Анна" }, chat: { id: 1 }, text: "🟢 OPEN" },
  };

  await handleUpdate(store, client, update);

  assertEquals(sent.some((m) => m.text.includes("Не понимаю")), false);
});
```

- [ ] **Step 12: Run every test file touched so far**

Run: `deno test supabase/functions/`
Expected: PASS — all suites from Tasks 1–6 green.

- [ ] **Step 13: Commit**

```bash
git add supabase/functions/_shared/time.ts supabase/functions/_shared/time_test.ts supabase/functions/_shared/notify.ts supabase/functions/_shared/notify_test.ts supabase/functions/telegram-webhook/checklist.ts supabase/functions/telegram-webhook/checklist_test.ts supabase/functions/telegram-webhook/handlers/open.ts supabase/functions/telegram-webhook/handlers/open_test.ts supabase/functions/telegram-webhook/router.ts supabase/functions/telegram-webhook/callbackRouter.ts supabase/functions/telegram-webhook/handleUpdate_test.ts
git commit -m "Add open-shift checklist, размен entry, and discrepancy warning"
```

---

### Task 7: Close-shift flow (checklist with photo items, closing float amount)

**Files:**
- Create: `supabase/functions/telegram-webhook/handlers/close.ts`
- Test: `supabase/functions/telegram-webhook/handlers/close_test.ts`
- Modify: `supabase/functions/telegram-webhook/router.ts`
- Modify: `supabase/functions/telegram-webhook/callbackRouter.ts`

**Interfaces:**
- Consumes: everything Task 6 produces (`notifyAdmins`, `renderChecklistKeyboard`, `isChecklistComplete`, `renderEmployeeKeyboard`, `formatVenueTime`, `todayDateKey`) plus `Store`/`TelegramClient` types.
- Produces: `handleCloserButton`, `handleCloseChecklistToggle`, `handleClosePhoto`, `handleClosingFloatAmount`; session states `"awaiting_close_photo"` (`data: { shiftId, checklistItemId, chatId, messageId }`) and `"awaiting_closing_float"` (`data: { shiftId }`) that Task 9's reminder job must recognize as "closing in progress" if it ever needs to (it doesn't yet, but the names are now reserved).

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/telegram-webhook/handlers/close_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { handleCloserButton, handleCloseChecklistToggle, handleClosePhoto, handleClosingFloatAmount } from "./close.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string; replyMarkup?: unknown }[] = [];
  const photos: { chatId: number; fileId: string }[] = [];
  const edited: { chatId: number; messageId: number; markup: unknown }[] = [];
  const answered: { id: string; text?: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text, opts) { sent.push({ chatId, text, replyMarkup: opts?.replyMarkup }); },
    async sendPhoto(chatId, fileId) { photos.push({ chatId, fileId }); },
    async answerCallbackQuery(id, text) { answered.push({ id, text }); },
    async editMessageReplyMarkup(chatId, messageId, markup) { edited.push({ chatId, messageId, markup }); },
    async setWebhook() {},
  };
  return { client, sent, photos, edited, answered };
}

function msg(fromId: number, text?: string, photo?: { file_id: string }[]): TelegramMessage {
  return { message_id: 1, from: { id: fromId, first_name: "Анна" }, chat: { id: fromId }, text, photo };
}

function toggle(fromId: number, itemId: string, messageId = 7): TelegramCallbackQuery {
  return { id: "cbq", from: { id: fromId, first_name: "Анна" }, message: { chat: { id: fromId }, message_id: messageId }, data: `chk:close:${itemId}` };
}

Deno.test("CLOSER before the shift was ever opened tells the employee to open first", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await handleCloserButton(store, client, msg(1, "🔴 CLOSER"));

  assertEquals(sent, [{ chatId: 1, text: "Сначала откройте смену кнопкой OPEN.", replyMarkup: undefined }]);
});

Deno.test("CLOSER when the shift is already closed today tells the employee, not a second checklist", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "closed" });
  const { client, sent } = fakeTelegram();

  await handleCloserButton(store, client, msg(1, "🔴 CLOSER"));

  assertEquals(sent, [{ chatId: 1, text: "Смена уже закрыта.", replyMarkup: undefined }]);
});

Deno.test("CLOSER on an open shift shows the closing checklist", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "open" });
  await store.addChecklistItem("close", "Фото отчёта с кассы", true);
  const { client, sent } = fakeTelegram();

  await handleCloserButton(store, client, msg(1, "🔴 CLOSER"));

  assertEquals(sent.length, 1);
  assertEquals((sent[0].replyMarkup as { inline_keyboard: unknown[] }).inline_keyboard.length, 1);
});

Deno.test("toggling a non-photo close item marks it done immediately and edits the keyboard", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "open" });
  const item = await store.addChecklistItem("close", "Выключить кофемашину", false);
  const { client, edited, answered } = fakeTelegram();

  await handleCloseChecklistToggle(store, client, toggle(1, item.id), item.id);

  assertEquals(edited.length, 1);
  assertEquals(answered, [{ id: "cbq", text: undefined }]);
  assertEquals((await store.getChecklistProgress(shift.id))[0].done, true);
});

Deno.test("toggling a photo-required item does not mark it done — it asks for a photo instead", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "open" });
  const item = await store.addChecklistItem("close", "Фото отчёта с кассы", true);
  const { client, sent, edited } = fakeTelegram();

  await handleCloseChecklistToggle(store, client, toggle(1, item.id), item.id);

  assertEquals(edited, []);
  assertEquals(sent, [{ chatId: 1, text: "Пришлите фото: Фото отчёта с кассы 📎", replyMarkup: undefined }]);
  assertEquals(await store.getChecklistProgress(shift.id), []);

  const session = await store.getSession(1);
  assertEquals(session.state, "awaiting_close_photo");
  assertEquals(session.data, { shiftId: shift.id, checklistItemId: item.id, chatId: 1, messageId: 7 });
});

Deno.test("tapping an item that is already done answers with 'already marked' and changes nothing", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "open" });
  const item = await store.addChecklistItem("close", "Сдать ключи", false);
  await store.setChecklistProgress(shift.id, item.id, true);
  const { client, answered, edited } = fakeTelegram();

  await handleCloseChecklistToggle(store, client, toggle(1, item.id), item.id);

  assertEquals(answered, [{ id: "cbq", text: "Уже отмечено." }]);
  assertEquals(edited, []);
});

Deno.test("a text message while awaiting a photo is rejected and re-asks for a photo", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  await store.setSession(1, "awaiting_close_photo", { shiftId: "s1", checklistItemId: "i1", chatId: 1, messageId: 7 });
  const { client, sent } = fakeTelegram();

  await handleClosePhoto(store, client, msg(1, "вот фото словами"));

  assertEquals(sent, [{ chatId: 1, text: "Нужно фото. Пришлите его как изображение.", replyMarkup: undefined }]);
});

Deno.test("sending the photo completes the only close item and moves straight to the closing-float question", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "open" });
  const item = await store.addChecklistItem("close", "Фото отчёта с кассы", true);
  await store.setSession(1, "awaiting_close_photo", { shiftId: shift.id, checklistItemId: item.id, chatId: 1, messageId: 7 });
  const { client, sent, edited } = fakeTelegram();

  await handleClosePhoto(store, client, msg(1, undefined, [{ file_id: "small" }, { file_id: "biggest" }]));

  const progress = await store.getChecklistProgress(shift.id);
  assertEquals(progress[0].done, true);
  assertEquals(progress[0].photoFileId, "biggest");
  assertEquals(edited, [{ chatId: 1, messageId: 7, markup: { inline_keyboard: [[{ text: "✅ Фото отчёта с кассы", callback_data: `chk:close:${item.id}` }]] } }]);
  assertEquals(sent, [{ chatId: 1, text: "Сколько наличных (размена) оставляете в кассе для следующей смены?", replyMarkup: undefined }]);
  assertEquals((await store.getSession(1)).state, "awaiting_closing_float");
});

Deno.test("a non-numeric closing float amount gets a re-prompt and the shift stays open", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await handleClosingFloatAmount(store, client, msg(1, "не знаю"), shift.id);

  assertEquals(sent, [{ chatId: 1, text: "Не понял сумму. Введите число, например 3000.", replyMarkup: undefined }]);
  assertEquals((await store.getShiftById(shift.id))?.status, "open");
});

Deno.test("a valid closing float amount closes the shift, confirms to the employee, and notifies admins", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "open" });
  const item = await store.addChecklistItem("close", "Фото отчёта с кассы", true);
  await store.setChecklistProgress(shift.id, item.id, true, "the-photo-id");
  const { client, sent, photos } = fakeTelegram();

  await handleClosingFloatAmount(store, client, msg(1, "3000"), shift.id);

  const updated = await store.getShiftById(shift.id);
  assertEquals(updated?.status, "closed");
  assertEquals(updated?.closingFloatAmount, 3000);
  assertEquals(sent.some((m) => m.chatId === 1 && m.text.includes("Смена закрыта")), true);
  assertEquals(sent.some((m) => m.chatId === 999 && m.text.includes("закрыла смену")), true);
  assertEquals(photos, [{ chatId: 999, fileId: "the-photo-id" }]);
  assertEquals((await store.getSession(1)).state, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test supabase/functions/telegram-webhook/handlers/close_test.ts`
Expected: FAIL — `close.ts` does not exist yet.

- [ ] **Step 3: Implement `handlers/close.ts`**

```ts
// supabase/functions/telegram-webhook/handlers/close.ts
import type { Store } from "../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { formatVenueTime, todayDateKey } from "../../_shared/time.ts";
import { notifyAdmins } from "../../_shared/notify.ts";
import { isChecklistComplete, renderChecklistKeyboard } from "../checklist.ts";
import { renderEmployeeKeyboard } from "../keyboards.ts";
import type { ChecklistItem, ChecklistProgress } from "../../_shared/store.ts";

export async function handleCloserButton(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(message.from.id);
  if (!employee) return;

  const today = todayDateKey();
  const shift = await store.getShift(employee.id, today);

  if (!shift || shift.status === "pending") {
    await telegram.sendMessage(message.chat.id, "Сначала откройте смену кнопкой OPEN.");
    return;
  }
  if (shift.status === "closed") {
    await telegram.sendMessage(message.chat.id, "Смена уже закрыта.");
    return;
  }

  const items = await store.listChecklistItems("close");
  const progress = await store.getChecklistProgress(shift.id);
  await telegram.sendMessage(message.chat.id, "Перед закрытием отметьте пункты:", {
    replyMarkup: renderChecklistKeyboard(items, progress),
  });
}

export async function handleCloseChecklistToggle(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
  itemId: string,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(callbackQuery.from.id);
  if (!employee) { await telegram.answerCallbackQuery(callbackQuery.id); return; }

  const today = todayDateKey();
  const shift = await store.getShift(employee.id, today);
  if (!shift || shift.status !== "open") {
    await telegram.answerCallbackQuery(callbackQuery.id, "Сначала нажмите CLOSER.");
    return;
  }

  const items = await store.listChecklistItems("close");
  const item = items.find((i) => i.id === itemId);
  if (!item) { await telegram.answerCallbackQuery(callbackQuery.id); return; }

  const progress = await store.getChecklistProgress(shift.id);
  if (progress.find((p) => p.checklistItemId === item.id)?.done) {
    await telegram.answerCallbackQuery(callbackQuery.id, "Уже отмечено.");
    return;
  }

  if (item.requiresPhoto) {
    await store.setSession(callbackQuery.from.id, "awaiting_close_photo", {
      shiftId: shift.id,
      checklistItemId: item.id,
      chatId: callbackQuery.message.chat.id,
      messageId: callbackQuery.message.message_id,
    });
    await telegram.answerCallbackQuery(callbackQuery.id);
    await telegram.sendMessage(callbackQuery.message.chat.id, `Пришлите фото: ${item.label} 📎`);
    return;
  }

  await store.setChecklistProgress(shift.id, item.id, true);
  const updatedProgress = await store.getChecklistProgress(shift.id);

  await telegram.editMessageReplyMarkup(
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    renderChecklistKeyboard(items, updatedProgress),
  );
  await telegram.answerCallbackQuery(callbackQuery.id);

  await maybeAskClosingFloat(store, telegram, callbackQuery.message.chat.id, callbackQuery.from.id, items, updatedProgress);
}

export async function handleClosePhoto(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const session = await store.getSession(message.from.id);
  const data = session.data as { shiftId: string; checklistItemId: string; chatId: number; messageId: number };

  if (!message.photo || message.photo.length === 0) {
    await telegram.sendMessage(message.chat.id, "Нужно фото. Пришлите его как изображение.");
    return;
  }
  const fileId = message.photo[message.photo.length - 1].file_id;

  await store.setChecklistProgress(data.shiftId, data.checklistItemId, true, fileId);
  await store.clearSession(message.from.id);

  const items = await store.listChecklistItems("close");
  const progress = await store.getChecklistProgress(data.shiftId);

  await telegram.editMessageReplyMarkup(data.chatId, data.messageId, renderChecklistKeyboard(items, progress));

  await maybeAskClosingFloat(store, telegram, message.chat.id, message.from.id, items, progress);
}

async function maybeAskClosingFloat(
  store: Store,
  telegram: TelegramClient,
  chatId: number,
  telegramId: number,
  items: ChecklistItem[],
  progress: ChecklistProgress[],
): Promise<void> {
  if (!isChecklistComplete(items, progress)) return;
  const shiftId = progress[0].shiftId;
  await store.setSession(telegramId, "awaiting_closing_float", { shiftId });
  await telegram.sendMessage(chatId, "Сколько наличных (размена) оставляете в кассе для следующей смены?");
}

export async function handleClosingFloatAmount(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
  shiftId: string,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(message.from.id);
  if (!employee) return;

  const amount = Number((message.text ?? "").replace(",", ".").trim());
  if (!message.text || Number.isNaN(amount) || amount < 0) {
    await telegram.sendMessage(message.chat.id, "Не понял сумму. Введите число, например 3000.");
    return;
  }

  const updated = await store.updateShift(shiftId, {
    closingFloatAmount: amount,
    closedAt: new Date().toISOString(),
    status: "closed",
  });
  await store.clearSession(message.from.id);

  await telegram.sendMessage(message.chat.id, "Смена закрыта ✅ Хорошего вечера!", {
    replyMarkup: renderEmployeeKeyboard(updated),
  });

  await notifyAdmins(
    store,
    telegram,
    `🔴 ${employee.fullName} закрыла смену в ${formatVenueTime(updated.closedAt!)}. Оставлено в кассе: ${amount} ₽.`,
  );

  const progress = await store.getChecklistProgress(shiftId);
  const photoItem = progress.find((p) => p.photoFileId);
  if (photoItem?.photoFileId) {
    const admins = await store.listAdmins();
    for (const admin of admins) {
      await telegram.sendPhoto(admin.telegramId, photoItem.photoFileId);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test supabase/functions/telegram-webhook/handlers/close_test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Wire CLOSER, the close checklist callback, and the two new session states into the routers**

```ts
// supabase/functions/telegram-webhook/router.ts
import type { Store } from "../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../_shared/telegram.ts";
import { handleStart } from "./handlers/start.ts";
import { handleOpenButton, handleOpenCashAmount } from "./handlers/open.ts";
import { handleCloserButton, handleClosePhoto, handleClosingFloatAmount } from "./handlers/close.ts";

export async function handleMessage(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  const session = await store.getSession(message.from.id);

  if (session.state === "awaiting_open_cash") {
    await handleOpenCashAmount(store, telegram, message, session.data.shiftId as string);
    return;
  }
  if (session.state === "awaiting_close_photo") {
    await handleClosePhoto(store, telegram, message);
    return;
  }
  if (session.state === "awaiting_closing_float") {
    await handleClosingFloatAmount(store, telegram, message, session.data.shiftId as string);
    return;
  }

  if (message.text === "/start") {
    await handleStart(store, telegram, message);
    return;
  }
  if (message.text === "🟢 OPEN") {
    await handleOpenButton(store, telegram, message);
    return;
  }
  if (message.text === "🔴 CLOSER") {
    await handleCloserButton(store, telegram, message);
    return;
  }

  await telegram.sendMessage(message.chat.id, "Не понимаю эту команду. Используйте кнопки внизу экрана.");
}
```

```ts
// supabase/functions/telegram-webhook/callbackRouter.ts
import type { Store } from "../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient } from "../_shared/telegram.ts";
import { handleOpenChecklistToggle } from "./handlers/open.ts";
import { handleCloseChecklistToggle } from "./handlers/close.ts";

export async function handleCallbackQuery(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  const [kind, phase, itemId] = callbackQuery.data.split(":");

  if (kind === "chk" && phase === "open" && itemId) {
    await handleOpenChecklistToggle(store, telegram, callbackQuery, itemId);
    return;
  }
  if (kind === "chk" && phase === "close" && itemId) {
    await handleCloseChecklistToggle(store, telegram, callbackQuery, itemId);
    return;
  }

  await telegram.answerCallbackQuery(callbackQuery.id);
}
```

- [ ] **Step 6: Run every test file touched so far**

Run: `deno test supabase/functions/`
Expected: PASS — all suites from Tasks 1–7 green.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/telegram-webhook/handlers/close.ts supabase/functions/telegram-webhook/handlers/close_test.ts supabase/functions/telegram-webhook/router.ts supabase/functions/telegram-webhook/callbackRouter.ts
git commit -m "Add close-shift checklist with photo capture and closing float amount"
```

---

### Task 8: Manual X-report flow

**Files:**
- Create: `supabase/functions/telegram-webhook/handlers/xreport.ts`
- Test: `supabase/functions/telegram-webhook/handlers/xreport_test.ts`
- Modify: `supabase/functions/telegram-webhook/router.ts`
- Modify: `supabase/functions/telegram-webhook/callbackRouter.ts`

**Interfaces:**
- Consumes: `notifyAdmins`, `formatVenueTime`, `todayDateKey` from Task 6; `Store`/`TelegramClient` types.
- Produces: `handleXreportButton`, `handleXreportStartCallback`, `handleXreportCash`, `handleXreportCashless`; session states `"awaiting_xreport_cash"` (`data: { shiftId }`) and `"awaiting_xreport_cashless"` (`data: { shiftId, cash }`); the callback data string `"xreport:start"` that Task 9's reminder message must use on its inline button.

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/telegram-webhook/handlers/xreport_test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../_shared/store.ts";
import type { TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { handleXreportButton, handleXreportCash, handleXreportCashless } from "./xreport.ts";

function fakeTelegram() {
  const sent: { chatId: number; text: string }[] = [];
  const client: TelegramClient = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); },
    async sendPhoto() {}, async answerCallbackQuery() {}, async editMessageReplyMarkup() {}, async setWebhook() {},
  };
  return { client, sent };
}

function msg(fromId: number, text: string): TelegramMessage {
  return { message_id: 1, from: { id: fromId, first_name: "Анна" }, chat: { id: fromId }, text };
}

Deno.test("the X-report button without an open shift tells the employee to open first", async () => {
  const store = createInMemoryStore();
  await store.addEmployee(1, "Анна");
  const { client, sent } = fakeTelegram();

  await handleXreportButton(store, client, msg(1, "🧾 Контрольный X-отчёт"));

  assertEquals(sent, [{ chatId: 1, text: "Сначала откройте смену кнопкой OPEN." }]);
  assertEquals((await store.getSession(1)).state, null);
});

Deno.test("the X-report button with an open shift asks for the cash amount", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  await store.updateShift(shift.id, { status: "open" });
  const { client, sent } = fakeTelegram();

  await handleXreportButton(store, client, msg(1, "🧾 Контрольный X-отчёт"));

  assertEquals(sent, [{ chatId: 1, text: "Введите наличные:" }]);
  assertEquals(await store.getSession(1), { state: "awaiting_xreport_cash", data: { shiftId: shift.id } });
});

Deno.test("a non-numeric cash figure re-prompts without advancing to the cashless question", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleXreportCash(store, client, msg(1, "много"), "shift-1");

  assertEquals(sent, [{ chatId: 1, text: "Не понял сумму. Введите число, например 18400." }]);
});

Deno.test("a numeric cash figure moves on to asking for cashless, remembering the cash figure", async () => {
  const store = createInMemoryStore();
  const { client, sent } = fakeTelegram();

  await handleXreportCash(store, client, msg(1, "18400"), "shift-1");

  assertEquals(sent, [{ chatId: 1, text: "Введите безналичные:" }]);
  assertEquals(await store.getSession(1), { state: "awaiting_xreport_cashless", data: { shiftId: "shift-1", cash: 18400 } });
});

Deno.test("a non-numeric cashless figure re-prompts and does not save the report", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  const { client, sent } = fakeTelegram();

  await handleXreportCashless(store, client, msg(1, "хз"), shift.id, 18400);

  assertEquals(sent, [{ chatId: 1, text: "Не понял сумму. Введите число, например 42150." }]);
  assertEquals((await store.getShiftById(shift.id))?.xreportCash, null);
});

Deno.test("a numeric cashless figure saves the report, confirms to the employee, and notifies admins", async () => {
  const store = createInMemoryStore();
  await store.addAdmin(999, "RCA");
  const employee = await store.addEmployee(1, "Анна");
  const shift = await store.createShift(employee.id, "2026-09-25");
  const { client, sent } = fakeTelegram();

  await handleXreportCashless(store, client, msg(1, "42150"), shift.id, 18400);

  const updated = await store.getShiftById(shift.id);
  assertEquals(updated?.xreportCash, 18400);
  assertEquals(updated?.xreportCashless, 42150);
  assertEquals(sent.some((m) => m.chatId === 1 && m.text === "Принято, спасибо ✅"), true);
  const adminMessage = sent.find((m) => m.chatId === 999)?.text ?? "";
  assertEquals(adminMessage.includes("нал: 18400"), true);
  assertEquals(adminMessage.includes("безнал: 42150"), true);
  assertEquals((await store.getSession(1)).state, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test supabase/functions/telegram-webhook/handlers/xreport_test.ts`
Expected: FAIL — `xreport.ts` does not exist yet.

- [ ] **Step 3: Implement `handlers/xreport.ts`**

```ts
// supabase/functions/telegram-webhook/handlers/xreport.ts
import type { Store } from "../../_shared/store.ts";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage } from "../../_shared/telegram.ts";
import { formatVenueTime, todayDateKey } from "../../_shared/time.ts";
import { notifyAdmins } from "../../_shared/notify.ts";

async function startXreport(
  store: Store,
  telegram: TelegramClient,
  telegramId: number,
  chatId: number,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(telegramId);
  if (!employee) return;

  const shift = await store.getShift(employee.id, todayDateKey());
  if (!shift || shift.status !== "open") {
    await telegram.sendMessage(chatId, "Сначала откройте смену кнопкой OPEN.");
    return;
  }

  await store.setSession(telegramId, "awaiting_xreport_cash", { shiftId: shift.id });
  await telegram.sendMessage(chatId, "Введите наличные:");
}

export async function handleXreportButton(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
): Promise<void> {
  await startXreport(store, telegram, message.from.id, message.chat.id);
}

export async function handleXreportStartCallback(
  store: Store,
  telegram: TelegramClient,
  callbackQuery: TelegramCallbackQuery,
): Promise<void> {
  await startXreport(store, telegram, callbackQuery.from.id, callbackQuery.message.chat.id);
  await telegram.answerCallbackQuery(callbackQuery.id);
}

export async function handleXreportCash(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
  shiftId: string,
): Promise<void> {
  const amount = Number((message.text ?? "").replace(",", ".").trim());
  if (!message.text || Number.isNaN(amount) || amount < 0) {
    await telegram.sendMessage(message.chat.id, "Не понял сумму. Введите число, например 18400.");
    return;
  }

  await store.setSession(message.from.id, "awaiting_xreport_cashless", { shiftId, cash: amount });
  await telegram.sendMessage(message.chat.id, "Введите безналичные:");
}

export async function handleXreportCashless(
  store: Store,
  telegram: TelegramClient,
  message: TelegramMessage,
  shiftId: string,
  cash: number,
): Promise<void> {
  const employee = await store.getEmployeeByTelegramId(message.from.id);
  if (!employee) return;

  const amount = Number((message.text ?? "").replace(",", ".").trim());
  if (!message.text || Number.isNaN(amount) || amount < 0) {
    await telegram.sendMessage(message.chat.id, "Не понял сумму. Введите число, например 42150.");
    return;
  }

  const now = new Date().toISOString();
  await store.updateShift(shiftId, { xreportCash: cash, xreportCashless: amount, xreportAt: now });
  await store.clearSession(message.from.id);

  await telegram.sendMessage(message.chat.id, "Принято, спасибо ✅");
  await notifyAdmins(
    store,
    telegram,
    `🧾 X-отчёт, ${employee.fullName} — ${formatVenueTime(now)}\nнал: ${cash} ₽\nбезнал: ${amount} ₽`,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test supabase/functions/telegram-webhook/handlers/xreport_test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the X-report button, its inline-button twin, and the two session states into the routers**

```ts
// supabase/functions/telegram-webhook/router.ts — add these two branches to the session-state checks
  if (session.state === "awaiting_xreport_cash") {
    await handleXreportCash(store, telegram, message, session.data.shiftId as string);
    return;
  }
  if (session.state === "awaiting_xreport_cashless") {
    await handleXreportCashless(store, telegram, message, session.data.shiftId as string, session.data.cash as number);
    return;
  }
```

```ts
// supabase/functions/telegram-webhook/router.ts — add this branch next to the other text-command checks
  if (message.text === "🧾 Контрольный X-отчёт") {
    await handleXreportButton(store, telegram, message);
    return;
  }
```

Add the matching imports to the top of `router.ts`:
```ts
import { handleXreportButton, handleXreportCash, handleXreportCashless } from "./handlers/xreport.ts";
```

```ts
// supabase/functions/telegram-webhook/callbackRouter.ts — add this branch, plus its import
import { handleXreportStartCallback } from "./handlers/xreport.ts";
// ...
  if (callbackQuery.data === "xreport:start") {
    await handleXreportStartCallback(store, telegram, callbackQuery);
    return;
  }
```

- [ ] **Step 6: Run every test file touched so far**

Run: `deno test supabase/functions/`
Expected: PASS — all suites from Tasks 1–8 green.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/telegram-webhook/handlers/xreport.ts supabase/functions/telegram-webhook/handlers/xreport_test.ts supabase/functions/telegram-webhook/router.ts supabase/functions/telegram-webhook/callbackRouter.ts
git commit -m "Add manual X-report flow"
```
