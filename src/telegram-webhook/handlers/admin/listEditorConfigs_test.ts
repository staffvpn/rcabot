import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createInMemoryStore } from "../../../_shared/store.ts";
import { checklistCloseConfig, checklistOpenConfig, expiryConfig } from "./listEditorConfigs.ts";

Deno.test("checklistOpenConfig.addFromText adds a plain checkbox item", async () => {
  const store = createInMemoryStore();
  const result = await checklistOpenConfig.addFromText(store, "Зал чистый");
  assertEquals(result, { ok: true });
  assertEquals((await store.listChecklistItems("open"))[0], { id: (await store.listChecklistItems("open"))[0].id, phase: "open", position: 1, label: "Зал чистый", requiresPhoto: false });
});

Deno.test("checklistCloseConfig.addFromText with a 'фото:' prefix adds a photo-required item", async () => {
  const store = createInMemoryStore();
  await checklistCloseConfig.addFromText(store, "фото: Фото отчёта с кассы");
  const items = await store.listChecklistItems("close");
  assertEquals(items[0].label, "Фото отчёта с кассы");
  assertEquals(items[0].requiresPhoto, true);
});

Deno.test("checklistOpenConfig.addFromText rejects an empty line", async () => {
  const store = createInMemoryStore();
  const result = await checklistOpenConfig.addFromText(store, "   ");
  assertEquals(result.ok, false);
});

Deno.test("checklistOpenConfig.listRows prefixes photo items with a camera for display", async () => {
  const store = createInMemoryStore();
  await store.addChecklistItem("open", "Зал чистый", false);
  await store.addChecklistItem("open", "Фото визитки", true);
  const rows = await checklistOpenConfig.listRows(store);
  assertEquals(rows.map((r) => r.label), ["Зал чистый", "📷 Фото визитки"]);
});

Deno.test("expiryConfig.addFromText parses 'Name — N суток' into name and days", async () => {
  const store = createInMemoryStore();
  const result = await expiryConfig.addFromText(store, "Тирамису — 4 суток");
  assertEquals(result, { ok: true });
  const items = await store.listExpiryItems();
  assertEquals(items[0].name, "Тирамису");
  assertEquals(items[0].shelfLifeDays, 4);
});

Deno.test("expiryConfig.addFromText rejects a line with no number", async () => {
  const store = createInMemoryStore();
  const result = await expiryConfig.addFromText(store, "Тирамису без срока");
  assertEquals(result.ok, false);
});
