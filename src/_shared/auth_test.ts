import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isAuthorized } from "./auth.ts";

Deno.test("isAuthorized allows the request when the secret header matches", () => {
  const req = new Request("https://example.com", { headers: { "x-telegram-bot-api-secret-token": "s3cret" } });
  assertEquals(isAuthorized(req, "s3cret"), true);
});

Deno.test("isAuthorized rejects the request when the secret header is missing or wrong", () => {
  const noHeader = new Request("https://example.com");
  assertEquals(isAuthorized(noHeader, "s3cret"), false);

  const wrongHeader = new Request("https://example.com", { headers: { "x-telegram-bot-api-secret-token": "nope" } });
  assertEquals(isAuthorized(wrongHeader, "s3cret"), false);
});

Deno.test("isAuthorized allows any request when no secret is configured", () => {
  const req = new Request("https://example.com");
  assertEquals(isAuthorized(req, undefined), true);
});
