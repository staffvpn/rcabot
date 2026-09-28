import type {
  Admin, ChecklistItem, ChecklistPhase, ChecklistProgress, Employee,
  ExpiryItem, InstructionArticle, ScheduleDay, Shift, Store,
} from "./store.ts";

function makeId(): string {
  return crypto.randomUUID();
}

function toEmployee(row: Record<string, unknown>): Employee {
  return { id: row.id as string, telegramId: Number(row.telegram_id), fullName: row.full_name as string, active: Boolean(row.active) };
}
function toAdmin(row: Record<string, unknown>): Admin {
  return { id: row.id as string, telegramId: Number(row.telegram_id), fullName: row.full_name as string };
}
function toChecklistItem(row: Record<string, unknown>): ChecklistItem {
  return {
    id: row.id as string, phase: row.phase as ChecklistPhase, position: row.position as number,
    label: row.label as string, requiresPhoto: Boolean(row.requires_photo),
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

const SHIFT_PATCH_COLUMNS: Record<string, string> = {
  openedAt: "opened_at", closedAt: "closed_at", openCashAmount: "open_cash_amount",
  closingFloatAmount: "closing_float_amount", cashDiscrepancy: "cash_discrepancy",
  xreportCash: "xreport_cash", xreportCashless: "xreport_cashless", xreportAt: "xreport_at",
  status: "status", remindedOpenAt: "reminded_open_at", notifiedLateAt: "notified_late_at",
  remindedCloseAt: "reminded_close_at", remindedXreportAt: "reminded_xreport_at",
};

export function createD1Store(db: D1Database): Store {
  async function first(sql: string, ...params: unknown[]): Promise<Record<string, unknown> | null> {
    return (await db.prepare(sql).bind(...params).first()) as Record<string, unknown> | null;
  }
  async function all(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
    const { results } = await db.prepare(sql).bind(...params).all();
    return results as Record<string, unknown>[];
  }
  async function run(sql: string, ...params: unknown[]): Promise<void> {
    await db.prepare(sql).bind(...params).run();
  }

  return {
    async getEmployeeByTelegramId(telegramId) {
      const row = await first("select * from employees where telegram_id = ?", telegramId);
      return row ? toEmployee(row) : null;
    },
    async listEmployees() {
      return (await all("select * from employees")).map(toEmployee);
    },
    async addEmployee(telegramId, fullName) {
      const id = makeId();
      await run(
        `insert into employees (id, telegram_id, full_name) values (?, ?, ?)
         on conflict (telegram_id) do update set full_name = excluded.full_name, active = 1`,
        id, telegramId, fullName,
      );
      return (await this.getEmployeeByTelegramId(telegramId))!;
    },
    async removeEmployee(id) {
      // Soft delete: shifts.employee_id is a foreign key, and shift history must survive a
      // departed employee. This also lets addEmployee reactivate the same row on a later
      // re-add instead of violating the telegram_id unique constraint with a second row.
      await run("update employees set active = 0 where id = ?", id);
    },

    async getAdminByTelegramId(telegramId) {
      const row = await first("select * from admins where telegram_id = ?", telegramId);
      return row ? toAdmin(row) : null;
    },
    async listAdmins() {
      return (await all("select * from admins")).map(toAdmin);
    },
    async addAdmin(telegramId, fullName) {
      const id = makeId();
      await run(
        `insert into admins (id, telegram_id, full_name) values (?, ?, ?)
         on conflict (telegram_id) do update set full_name = excluded.full_name`,
        id, telegramId, fullName,
      );
      return (await this.getAdminByTelegramId(telegramId))!;
    },
    async removeAdmin(id) {
      const countRow = await first("select count(*) as n from admins");
      if (Number(countRow?.n ?? 0) <= 1) throw new Error("Cannot remove the last remaining admin");
      await run("delete from admins where id = ?", id);
    },

    async getSchedule() {
      const rows = await all("select * from schedule order by weekday");
      return rows.map((r): ScheduleDay => ({ weekday: r.weekday as number, opensAt: r.opens_at as string, closesAt: r.closes_at as string }));
    },

    async listChecklistItems(phase) {
      return (await all("select * from checklist_items where phase = ? order by position", phase)).map(toChecklistItem);
    },
    async addChecklistItem(phase, label, requiresPhoto) {
      const existing = await this.listChecklistItems(phase);
      const id = makeId();
      const position = existing.length + 1;
      await run(
        "insert into checklist_items (id, phase, position, label, requires_photo) values (?, ?, ?, ?, ?)",
        id, phase, position, label, requiresPhoto ? 1 : 0,
      );
      return { id, phase, position, label, requiresPhoto };
    },
    async removeChecklistItem(id) {
      await run("delete from checklist_items where id = ?", id);
    },

    async listInstructions() {
      return (await all("select * from instructions order by position")).map(toInstruction);
    },
    async addInstruction(title, body, mediaUrl) {
      const existing = await this.listInstructions();
      const id = makeId();
      const position = existing.length + 1;
      await run(
        "insert into instructions (id, position, title, body, media_url) values (?, ?, ?, ?, ?)",
        id, position, title, body, mediaUrl,
      );
      return { id, position, title, body, mediaUrl };
    },
    async removeInstruction(id) {
      await run("delete from instructions where id = ?", id);
    },

    async listExpiryItems() {
      return (await all("select * from expiry_items order by position")).map(toExpiryItem);
    },
    async addExpiryItem(name, shelfLifeDays) {
      const existing = await this.listExpiryItems();
      const id = makeId();
      const position = existing.length + 1;
      await run(
        "insert into expiry_items (id, position, name, shelf_life_days) values (?, ?, ?, ?)",
        id, position, name, shelfLifeDays,
      );
      return { id, position, name, shelfLifeDays };
    },
    async removeExpiryItem(id) {
      await run("delete from expiry_items where id = ?", id);
    },

    async getShift(employeeId, shiftDate) {
      const row = await first("select * from shifts where employee_id = ? and shift_date = ?", employeeId, shiftDate);
      return row ? toShift(row) : null;
    },
    async getShiftById(id) {
      const row = await first("select * from shifts where id = ?", id);
      return row ? toShift(row) : null;
    },
    async createShift(employeeId, shiftDate) {
      const id = makeId();
      await run("insert into shifts (id, employee_id, shift_date) values (?, ?, ?)", id, employeeId, shiftDate);
      return (await this.getShiftById(id))!;
    },
    async updateShift(id, patch) {
      const entries = Object.entries(patch).filter(([key]) => key in SHIFT_PATCH_COLUMNS);
      if (entries.length > 0) {
        const setClause = entries.map(([key]) => `${SHIFT_PATCH_COLUMNS[key]} = ?`).join(", ");
        const values = entries.map(([, value]) => value);
        await run(`update shifts set ${setClause} where id = ?`, ...values, id);
      }
      return (await this.getShiftById(id))!;
    },
    async getPreviousClosedShift(beforeDate) {
      const row = await first(
        "select * from shifts where shift_date < ? and closing_float_amount is not null order by shift_date desc limit 1",
        beforeDate,
      );
      return row ? toShift(row) : null;
    },
    async listShiftsForDate(shiftDate) {
      return (await all("select * from shifts where shift_date = ?", shiftDate)).map(toShift);
    },

    async getChecklistProgress(shiftId) {
      const rows = await all("select * from shift_checklist_progress where shift_id = ?", shiftId);
      return rows.map((r): ChecklistProgress => ({
        shiftId: r.shift_id as string, checklistItemId: r.checklist_item_id as string,
        done: Boolean(r.done), photoFileId: (r.photo_file_id as string) ?? null,
      }));
    },
    async setChecklistProgress(shiftId, checklistItemId, done, photoFileId = null) {
      await run(
        `insert into shift_checklist_progress (id, shift_id, checklist_item_id, done, photo_file_id)
         values (?, ?, ?, ?, ?)
         on conflict (shift_id, checklist_item_id)
         do update set done = excluded.done, photo_file_id = excluded.photo_file_id`,
        makeId(), shiftId, checklistItemId, done ? 1 : 0, photoFileId,
      );
    },

    async getSession(telegramId) {
      const row = await first("select state, data from bot_sessions where telegram_id = ?", telegramId);
      return row ? { state: row.state as string | null, data: JSON.parse(row.data as string) } : { state: null, data: {} };
    },
    async setSession(telegramId, state, data = {}) {
      await run(
        `insert into bot_sessions (telegram_id, state, data, updated_at)
         values (?, ?, ?, datetime('now'))
         on conflict (telegram_id)
         do update set state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
        telegramId, state, JSON.stringify(data),
      );
    },
    async clearSession(telegramId) {
      await this.setSession(telegramId, null, {});
    },
  };
}
