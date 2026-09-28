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

Deno.test("removeEmployee soft-deletes: the row is marked inactive but shift history still resolves to it", async () => {
  const store = createInMemoryStore();
  const employee = await store.addEmployee(1, "Уволена");
  const shift = await store.createShift(employee.id, "2026-09-25");

  await store.removeEmployee(employee.id);

  const found = (await store.listEmployees()).find((e) => e.id === employee.id);
  assertEquals(found?.active, false);
  assertEquals((await store.getShiftById(shift.id))?.employeeId, employee.id);
});

Deno.test("addEmployee is idempotent by telegram id: re-adding reactivates the same row instead of duplicating it", async () => {
  const store = createInMemoryStore();
  const first = await store.addEmployee(555, "Анна");
  await store.removeEmployee(first.id);

  const second = await store.addEmployee(555, "Анна Б.");

  assertEquals(second.id, first.id);
  assertEquals(second.active, true);
  assertEquals(second.fullName, "Анна Б.");
  assertEquals((await store.listEmployees()).length, 1);
});

Deno.test("addAdmin is idempotent by telegram id: re-adding the same person does not create a duplicate", async () => {
  const store = createInMemoryStore();
  const first = await store.addAdmin(1, "RCA");

  const second = await store.addAdmin(1, "RCA (обновлено)");

  assertEquals(second.id, first.id);
  assertEquals(second.fullName, "RCA (обновлено)");
  assertEquals((await store.listAdmins()).length, 1);
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
