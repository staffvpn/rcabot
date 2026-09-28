import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createTelegramClient } from "./telegram.ts";

Deno.test("sendMessage posts text and chat id to the sendMessage endpoint", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: input.toString(), body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
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

Deno.test("sendMessage returns the sent message's id from Telegram's response", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), { status: 200 });

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  const result = await client.sendMessage(1, "hello");

  assertEquals(result, { messageId: 777 });
});

Deno.test("sendMessage attaches a reply_markup keyboard when given one", async () => {
  const calls: { body: Record<string, unknown> }[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push({ body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
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

Deno.test("deleteMessage posts chat id and message id to the deleteMessage endpoint", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: input.toString(), body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  };

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  await client.deleteMessage(1, 42);

  assertEquals(calls[0].url, "https://api.telegram.org/botTEST_TOKEN/deleteMessage");
  assertEquals(calls[0].body, { chat_id: 1, message_id: 42 });
});

Deno.test("deleteMessage swallows failures instead of throwing — cleanup is best-effort (message may already be gone or too old)", async () => {
  const fakeFetch: typeof fetch = async () => new Response("not found", { status: 400 });
  const client = createTelegramClient("TEST_TOKEN", fakeFetch);

  await client.deleteMessage(1, 42); // must not reject
});

Deno.test("getChatByUsername resolves a private chat's id and first name", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: input.toString(), body: JSON.parse(init!.body as string) });
    return new Response(
      JSON.stringify({ ok: true, result: { id: 555, type: "private", first_name: "Аня", username: "annet_d" } }),
      { status: 200 },
    );
  };

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  const result = await client.getChatByUsername("@annet_d");

  assertEquals(calls[0].url, "https://api.telegram.org/botTEST_TOKEN/getChat");
  assertEquals(calls[0].body, { chat_id: "@annet_d" });
  assertEquals(result, { telegramId: 555, fullName: "Аня" });
});

Deno.test("getChatByUsername strips a missing leading @ before calling the API", async () => {
  const calls: { body: unknown }[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    calls.push({ body: JSON.parse(init!.body as string) });
    return new Response(JSON.stringify({ ok: true, result: { id: 1, type: "private", first_name: "X" } }), { status: 200 });
  };

  const client = createTelegramClient("TEST_TOKEN", fakeFetch);
  await client.getChatByUsername("annet_d");

  assertEquals(calls[0].body, { chat_id: "@annet_d" });
});

Deno.test("getChatByUsername returns null instead of throwing when Telegram can't find the chat", async () => {
  const fakeFetch: typeof fetch = async () => new Response("Bad Request: chat not found", { status: 400 });
  const client = createTelegramClient("TEST_TOKEN", fakeFetch);

  const result = await client.getChatByUsername("@nobody"); // must not reject

  assertEquals(result, null);
});

Deno.test("getChatByUsername returns null for a non-private chat (e.g. a channel username)", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: true, result: { id: -100, type: "channel", first_name: "" } }), { status: 200 });
  const client = createTelegramClient("TEST_TOKEN", fakeFetch);

  const result = await client.getChatByUsername("@somechannel");

  assertEquals(result, null);
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
