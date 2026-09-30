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

Deno.test("parseScheduleDate rejects calendar-invalid dates (September has 30 days, February has 28/29)", () => {
  const now = onDate("2026-09-01T00:00:00Z");
  assertEquals(parseScheduleDate("31.09", now), null); // September has no 31st
  assertEquals(parseScheduleDate("30.02", now), null); // February never has a 30th
});

Deno.test("parseScheduleDate accepts Feb 29 on a leap year and rejects it on a non-leap year", () => {
  assertEquals(parseScheduleDate("29.02", onDate("2027-01-01T00:00:00Z")), null); // 2027 is not a leap year
  assertEquals(parseScheduleDate("29.02", onDate("2028-01-01T00:00:00Z")), "2028-02-29"); // 2028 is a leap year
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

Deno.test("parseScheduleTime rejects out-of-range hours and minutes", () => {
  assertEquals(parseScheduleTime("18:60-19:00"), null); // no 60th minute
  assertEquals(parseScheduleTime("25:99-30:00"), null); // no 25th hour
  assertEquals(parseScheduleTime("08:30-24:00"), null); // hours are 0-23
});
