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
