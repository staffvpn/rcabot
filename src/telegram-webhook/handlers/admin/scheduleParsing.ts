import { todayDateKey } from "../../../_shared/time.ts";

const pad2 = (n: number): string => String(n).padStart(2, "0");

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function parseScheduleDate(text: string, now: Date = new Date()): string | null {
  const match = /^(\d{1,2})\.(\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const todayKey = todayDateKey(now);
  const year = Number(todayKey.slice(0, 4));

  let candidate = `${year}-${pad2(month)}-${pad2(day)}`;
  let candidateYear = year;
  if (candidate < todayKey) {
    candidateYear = year + 1;
    candidate = `${candidateYear}-${pad2(month)}-${pad2(day)}`;
  }

  // Rejects e.g. 31.09 or 30.02 — a real calendar day, not just two numbers in range.
  if (!isRealCalendarDate(candidateYear, month, day)) return null;
  return candidate;
}

export function parseScheduleTime(text: string): { startTime: string; endTime: string } | null {
  const match = /^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [, h1, m1, h2, m2] = match;
  const startH = Number(h1);
  const startM = Number(m1);
  const endH = Number(h2);
  const endM = Number(m2);
  if (startH > 23 || startM > 59 || endH > 23 || endM > 59) return null;
  return { startTime: `${pad2(startH)}:${m1}`, endTime: `${pad2(endH)}:${m2}` };
}
