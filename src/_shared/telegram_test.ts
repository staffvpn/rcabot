import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createTelegramClient } from "./telegram.ts";

Deno.test("sendMessage posts text and chat id to the sendMessage endpoint", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: input.toString(), body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  await client.sendMessage(12345, "hello");

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.telegram.org/botTEST_TOKEN/sendMessage");
  // JSON.stringify drops keys whose value is undefined, so the body that actually
  // crosses the wire (and round-trips back through JSON.parse in the fake fetch above)
  // never has a reply_markup key at all when none was passed.
  assertEquals(calls[0].body, { chat_id: 12345, text: "hello" });
});

Deno.test("sendMessage attaches a reply_markup keyboard when given one", async () => {
  const calls: { body: Record<string, unknown> }[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push({ body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  await client.sendMessage(1, "menu", {
    replyMarkup: { inline_keyboard: [[{ text: "OPEN", callback_data: "shift:open" }]] },
  });

  assertEquals(calls[0].body.reply_markup, {
    inline_keyboard: [[{ text: "OPEN", callback_data: "shift:open" }]],
  });
});

Deno.test("sendMessage throws when Telegram responds with a non-2xx status", async () => {
  const fakeFetch: typeof fetch = async () => new Response("bad request", { status: 400 });
  const client = createTelegramClient("TEST_TOKEN", fakeFetch);

  let threw = false;
  try {
    await client.sendMessage(1, "x");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("answerCallbackQuery posts the callback query id", async () => {
  const calls: { body: Record<string, unknown> }[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push({ body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  await client.answerCallbackQuery("cbq-1", "Готово");

  assertEquals(calls[0].body, { callback_query_id: "cbq-1", text: "Готово" });
});

Deno.test("editMessageReplyMarkup posts chat id, message id, and the new markup", async () => {
  const calls: { body: Record<string, unknown> }[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push({ body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  const markup = { inline_keyboard: [[{ text: "✅ Готово", callback_data: "chk:open:1" }]] };
  await client.editMessageReplyMarkup(1, 42, markup);

  assertEquals(calls[0].body, { chat_id: 1, message_id: 42, reply_markup: markup });
});
