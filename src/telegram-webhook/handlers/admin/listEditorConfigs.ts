import type { Store } from "../../../_shared/store.ts";
import type { ListEditorConfig, ListEditorRow } from "./listEditor.ts";

function parseChecklistLine(text: string): { label: string; requiresPhoto: boolean } {
  const trimmed = text.trim();
  const photoPrefix = /^фото:\s*/i;
  if (photoPrefix.test(trimmed)) {
    return { label: trimmed.replace(photoPrefix, ""), requiresPhoto: true };
  }
  return { label: trimmed, requiresPhoto: false };
}

function checklistConfig(phase: "open" | "close", key: string, promptText: string): ListEditorConfig {
  return {
    key,
    promptText,
    async listRows(store: Store): Promise<ListEditorRow[]> {
      const items = await store.listChecklistItems(phase);
      return items.map((i) => ({ id: i.id, label: i.requiresPhoto ? `📷 ${i.label}` : i.label }));
    },
    async addFromText(store: Store, text: string) {
      const { label, requiresPhoto } = parseChecklistLine(text);
      if (!label) return { ok: false as const, error: "Текст не может быть пустым." };
      await store.addChecklistItem(phase, label, requiresPhoto);
      return { ok: true as const };
    },
    async remove(store: Store, id: string) {
      await store.removeChecklistItem(id);
    },
  };
}

export const checklistOpenConfig = checklistConfig(
  "open",
  "checklist_open",
  "Текущие пункты чек-листа открытия. Нажмите 🗑, чтобы удалить, пришлите текст — чтобы добавить новый.",
);

export const checklistCloseConfig = checklistConfig(
  "close",
  "checklist_close",
  "Текущие пункты чек-листа закрытия. 📷 отмечает пункт, где нужно фото — напишите «фото: <текст>», чтобы добавить такой. Нажмите 🗑, чтобы удалить, пришлите текст — чтобы добавить новый.",
);

const EXPIRY_LINE = /^(.+?)\s*[-—]\s*(\d+)/;

export const expiryConfig: ListEditorConfig = {
  key: "expiry",
  promptText: "Текущий список сроков годности. Нажмите 🗑, чтобы удалить, пришлите строку «Название — N суток» — чтобы добавить новую.",
  async listRows(store: Store) {
    const items = await store.listExpiryItems();
    return items.map((i) => ({ id: i.id, label: `${i.name} — ${i.shelfLifeDays} суток` }));
  },
  async addFromText(store: Store, text: string) {
    const match = EXPIRY_LINE.exec(text.trim());
    if (!match) {
      return { ok: false as const, error: "Формат: «Название — количество суток», например «Тирамису — 4 суток»." };
    }
    await store.addExpiryItem(match[1].trim(), Number(match[2]));
    return { ok: true as const };
  },
  async remove(store: Store, id: string) {
    await store.removeExpiryItem(id);
  },
};

export const LIST_EDITOR_CONFIGS: Record<string, ListEditorConfig> = {
  checklist_open: checklistOpenConfig,
  checklist_close: checklistCloseConfig,
  expiry: expiryConfig,
};
