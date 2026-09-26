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
