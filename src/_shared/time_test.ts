import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dateKeyInTimezone, formatVenueTime, weekdayInTimezone, VENUE_TZ_OFFSET_MINUTES } from "./time.ts";

Deno.test("dateKeyInTimezone shows the venue's local date even just after UTC midnight", () => {
  // 2026-09-25 00:30 UTC = 2026-09-25 03:30 Moscow (UTC+3) — still the 25th locally either way,
  // so use a time where UTC and Moscow disagree on the calendar day.
  const lateUtc = new Date("2026-09-24T22:00:00.000Z"); // 2026-09-25 01:00 Moscow
  assertEquals(dateKeyInTimezone(lateUtc, VENUE_TZ_OFFSET_MINUTES), "2026-09-25");
});

Deno.test("weekdayInTimezone maps Monday to 0 and Sunday to 6", () => {
  const monday = new Date("2026-09-21T10:00:00.000Z"); // a Monday
  const sunday = new Date("2026-09-27T10:00:00.000Z"); // the following Sunday
  assertEquals(weekdayInTimezone(monday, VENUE_TZ_OFFSET_MINUTES), 0);
  assertEquals(weekdayInTimezone(sunday, VENUE_TZ_OFFSET_MINUTES), 6);
});

Deno.test("formatVenueTime renders the venue-local HH:MM for a UTC timestamp", () => {
  assertEquals(formatVenueTime("2026-09-25T05:31:00.000Z"), "08:31"); // UTC+3
});
