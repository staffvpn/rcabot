import type { ReplyKeyboard } from "../_shared/telegram.ts";
import type { Shift } from "../_shared/store.ts";

export function renderEmployeeKeyboard(shift: Shift | null): ReplyKeyboard {
  const topRow = shift?.status === "open" ? ["🔴 CLOSER"] : ["🟢 OPEN"];
  return {
    keyboard: [topRow, ["🧾 Контрольный X-отчёт"], ["📖 Инструкции", "🍰 Сроки годности"]],
    resize_keyboard: true,
  };
}
