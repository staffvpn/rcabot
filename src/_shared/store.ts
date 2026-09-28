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
  parentId: string | null;
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
  /** parentId nests this article as a sub-section, shown only when its parent is opened. Not exposed via any admin flow — seeded by migration only. */
  addInstruction(title: string, body: string, mediaUrl: string | null, parentId?: string | null): Promise<InstructionArticle>;
  removeInstruction(id: string): Promise<void>;

  listExpiryItems(): Promise<ExpiryItem[]>;
  addExpiryItem(name: string, shelfLifeDays: number): Promise<ExpiryItem>;
  removeExpiryItem(id: string): Promise<void>;

  getShift(employeeId: string, shiftDate: string): Promise<Shift | null>;
  getShiftById(id: string): Promise<Shift | null>;
  createShift(employeeId: string, shiftDate: string): Promise<Shift>;
  updateShift(id: string, patch: Partial<Shift>): Promise<Shift>;
  /**
   * The most recent shift (any employee — single venue, shared cash drawer) closed before
   * `beforeDate`, i.e. one with `closingFloatAmount` actually set. Pending rows the cron
   * pre-creates for unworked days must never be returned here — they'd mask the real baseline.
   */
  getPreviousClosedShift(beforeDate: string): Promise<Shift | null>;
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
      for (const e of employees.values()) {
        if (e.telegramId === telegramId) {
          const reactivated = { ...e, fullName, active: true };
          employees.set(e.id, reactivated);
          return reactivated;
        }
      }
      const employee: Employee = { id: makeId(), telegramId, fullName, active: true };
      employees.set(employee.id, employee);
      return employee;
    },
    async removeEmployee(id) {
      // Soft delete: shifts.employee_id is a foreign key, and shift history must survive a
      // departed employee. This also lets addEmployee reactivate the same row on a later re-add
      // instead of violating the telegram_id unique constraint with a second row.
      const employee = employees.get(id);
      if (employee) employees.set(id, { ...employee, active: false });
    },

    async getAdminByTelegramId(telegramId) {
      for (const a of admins.values()) if (a.telegramId === telegramId) return a;
      return null;
    },
    async listAdmins() {
      return [...admins.values()];
    },
    async addAdmin(telegramId, fullName) {
      for (const a of admins.values()) {
        if (a.telegramId === telegramId) {
          const updated = { ...a, fullName };
          admins.set(a.id, updated);
          return updated;
        }
      }
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
    async addInstruction(title, body, mediaUrl, parentId = null) {
      const article: InstructionArticle = {
        id: makeId(),
        position: instructions.size + 1,
        title,
        body,
        mediaUrl,
        parentId,
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
    async getPreviousClosedShift(beforeDate) {
      const candidates = [...shifts.values()]
        .filter((s) => s.shiftDate < beforeDate && s.closingFloatAmount !== null)
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
