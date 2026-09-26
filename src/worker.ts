// This is the Worker's `fetch` export — the only thing wrangler.toml's `main`
// points at. Task 9 adds a `scheduled` export to this same file for the cron
// reminders, so one deployed Worker handles both the webhook and the cron tick.
import { createD1Store } from "./_shared/d1Store.ts";
import { createTelegramClient } from "./_shared/telegram.ts";
import { isAuthorized } from "./_shared/auth.ts";
import type { TelegramUpdate } from "./_shared/telegram.ts";
import { handleUpdate } from "./telegram-webhook/handleUpdate.ts";

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

    const update = (await request.json()) as TelegramUpdate;
    const store = createD1Store(env.DB);
    const telegram = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

    try {
      await handleUpdate(store, telegram, update);
    } catch (err) {
      console.error("handleUpdate failed", err);
    }
    return new Response("ok", { status: 200 });
  },
};
