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
