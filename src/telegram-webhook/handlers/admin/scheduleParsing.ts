import { todayDateKey } from "../../../_shared/time.ts";

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function parseScheduleDate(text: string, now: Date = new Date()): string | null {
  const match = /^(\d{1,2})\.(\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const todayKey = todayDateKey(now);
  const year = Number(todayKey.slice(0, 4));

  let candidate = `${year}-${pad2(month)}-${pad2(day)}`;
  if (candidate < todayKey) {
    candidate = `${year + 1}-${pad2(month)}-${pad2(day)}`;
  }
  return candidate;
}

export function parseScheduleTime(text: string): { startTime: string; endTime: string } | null {
  const match = /^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const [, h1, m1, h2, m2] = match;
  return { startTime: `${pad2(Number(h1))}:${m1}`, endTime: `${pad2(Number(h2))}:${m2}` };
}
