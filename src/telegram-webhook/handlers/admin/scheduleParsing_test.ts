import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseScheduleDate, parseScheduleTime } from "./scheduleParsing.ts";

function onDate(iso: string): Date {
  return new Date(iso); // UTC midnight; venue offset doesn't matter for these date-only tests
}

Deno.test("parseScheduleDate reads D.M as this year when the date hasn't passed yet", () => {
  const now = onDate("2026-09-01T00:00:00Z");
  assertEquals(parseScheduleDate("30.09", now), "2026-09-30");
});

Deno.test("parseScheduleDate accepts today's own date", () => {
  const now = onDate("2026-09-30T00:00:00Z");
  assertEquals(parseScheduleDate("30.09", now), "2026-09-30");
});

Deno.test("parseScheduleDate rolls to next year when the date already passed this year", () => {
  const now = onDate("2026-10-05T00:00:00Z");
  assertEquals(parseScheduleDate("30.09", now), "2027-09-30");
});

Deno.test("parseScheduleDate pads single-digit day/month", () => {
  const now = onDate("2026-01-01T00:00:00Z");
  assertEquals(parseScheduleDate("5.3", now), "2026-03-05");
});

Deno.test("parseScheduleDate rejects garbage and out-of-range values", () => {
  const now = onDate("2026-09-01T00:00:00Z");
  assertEquals(parseScheduleDate("не дата", now), null);
  assertEquals(parseScheduleDate("30/09", now), null);
  assertEquals(parseScheduleDate("32.09", now), null);
  assertEquals(parseScheduleDate("30.13", now), null);
});

Deno.test("parseScheduleTime reads HH:MM-HH:MM", () => {
  assertEquals(parseScheduleTime("08:30-14:30"), { startTime: "08:30", endTime: "14:30" });
});

Deno.test("parseScheduleTime accepts an en dash or spaces around the dash", () => {
  assertEquals(parseScheduleTime("08:30 – 14:30"), { startTime: "08:30", endTime: "14:30" });
  assertEquals(parseScheduleTime("9:00-15:00"), { startTime: "09:00", endTime: "15:00" });
});

Deno.test("parseScheduleTime rejects garbage", () => {
  assertEquals(parseScheduleTime("весь день"), null);
  assertEquals(parseScheduleTime("08:30"), null);
});
