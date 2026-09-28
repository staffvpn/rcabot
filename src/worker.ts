// This is the Worker's `fetch` export — the only thing wrangler.toml's `main`
// points at. This same file also exports `scheduled` for the cron reminders,
// so one deployed Worker handles both the webhook and the cron tick.
import { createD1Store } from "./_shared/d1Store.ts";
import { createTelegramClient } from "./_shared/telegram.ts";
import { isAuthorized } from "./_shared/auth.ts";
import type { TelegramUpdate } from "./_shared/telegram.ts";
import { handleUpdate } from "./telegram-webhook/handleUpdate.ts";
import { runCronTick } from "./cron-tick/run.ts";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("forbidden", { status: 403 });
    }

    const store = createD1Store(env.DB);
    const telegram = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

    try {
      const update = (await request.json()) as TelegramUpdate;
      await handleUpdate(store, telegram, update);
    } catch (err) {
      console.error("handleUpdate failed", err);
    }
    return new Response("ok", { status: 200 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const store = createD1Store(env.DB);
    const telegram = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
    try {
      await runCronTick(store, telegram);
    } catch (err) {
      console.error("runCronTick failed", err);
    }
  },
};
