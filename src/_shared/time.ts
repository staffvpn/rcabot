// The venue is in Moscow (UTC+3, no DST) — hardcoded because this bot serves one location (spec §2).
export const VENUE_TZ_OFFSET_MINUTES = 180;

export function dateKeyInTimezone(date: Date, tzOffsetMinutes: number): string {
  const shifted = new Date(date.getTime() + tzOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

export function weekdayInTimezone(date: Date, tzOffsetMinutes: number): number {
  const shifted = new Date(date.getTime() + tzOffsetMinutes * 60_000);
  const jsDay = shifted.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  return (jsDay + 6) % 7; // remapped to 0 = Monday .. 6 = Sunday, matching the `schedule` table
}

export function todayDateKey(now: Date = new Date()): string {
  return dateKeyInTimezone(now, VENUE_TZ_OFFSET_MINUTES);
}

export function todayWeekday(now: Date = new Date()): number {
  return weekdayInTimezone(now, VENUE_TZ_OFFSET_MINUTES);
}

export function formatVenueTime(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + VENUE_TZ_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(11, 16);
}
