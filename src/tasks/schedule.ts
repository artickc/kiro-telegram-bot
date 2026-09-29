/**
 * Schedule helpers: parse user input, compute the next run time (local
 * timezone), and produce human-readable descriptions.
 */
import type { Schedule, ScheduleType } from "./types.js";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function parseTime(s: string): { h: number; m: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return { h, m: min };
}

/**
 * Parse a strict local `YYYY-MM-DD HH:MM` (a `T` separator and `:SS` are also
 * accepted) into epoch ms, or undefined. Deliberately NOT `Date.parse`: V8's
 * fallback parser is lenient — it turns "next friday 2030" into 2030-01-01 and
 * rolls "2030-02-30" over into March — so a typo would silently schedule a task
 * at the wrong time instead of prompting for the right format.
 */
export function parseLocalDateTime(s: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const min = Number(m[5]);
  const sec = Number(m[6] ?? 0);
  if (h > 23 || min > 59 || sec > 59) return undefined;
  const date = new Date(y, mo - 1, d, h, min, sec, 0);
  // Reject calendar overflow (Feb 30, month 13, …): the fields must round-trip.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return undefined;
  return date.getTime();
}

/** Parse the free-text detail for a given schedule type into a Schedule. */
export function parseScheduleDetail(
  type: ScheduleType,
  text: string,
): { schedule?: Schedule; error?: string } {
  const t = text.trim();
  switch (type) {
    case "once": {
      const ms = parseLocalDateTime(t);
      if (ms === undefined) return { error: "Use format: YYYY-MM-DD HH:MM" };
      if (ms <= Date.now()) return { error: "That time is in the past." };
      return { schedule: { type, at: new Date(ms).toISOString() } };
    }
    case "daily": {
      const time = parseTime(t);
      if (!time) return { error: "Use format: HH:MM (e.g. 09:30)" };
      return { schedule: { type, time: fmt(time) } };
    }
    case "weekly": {
      const [dayStr, timeStr] = t.split(/\s+/);
      const weekday = DAYS.indexOf((dayStr ?? "").slice(0, 3).toLowerCase());
      const time = parseTime(timeStr ?? "");
      if (weekday < 0 || !time) return { error: "Use format: Mon 09:30" };
      return { schedule: { type, weekday, time: fmt(time) } };
    }
    case "monthly": {
      const [dayStr, timeStr] = t.split(/\s+/);
      const day = Number(dayStr);
      const time = parseTime(timeStr ?? "");
      if (!Number.isInteger(day) || day < 1 || day > 31 || !time) {
        return { error: "Use format: 15 09:30 (day-of-month time)" };
      }
      return { schedule: { type, day, time: fmt(time) } };
    }
    case "interval": {
      const mins = Number(t);
      if (!Number.isInteger(mins) || mins < 1) return { error: "Enter minutes, e.g. 90" };
      return { schedule: { type, everyMinutes: mins } };
    }
    default:
      return { error: "Unknown schedule type." };
  }
}

/** Next run time in epoch ms, or undefined if the schedule will never fire. */
export function computeNextRun(schedule: Schedule, from = Date.now()): number | undefined {
  switch (schedule.type) {
    case "once": {
      const ms = schedule.at ? Date.parse(schedule.at) : NaN;
      return !Number.isNaN(ms) && ms > from ? ms : undefined;
    }
    case "interval":
      return from + (schedule.everyMinutes ?? 60) * 60_000;
    case "daily":
      return nextDaily(schedule, from);
    case "weekly":
      return nextWeekly(schedule, from);
    case "monthly":
      return nextMonthly(schedule, from);
    default:
      return undefined;
  }
}

function nextDaily(s: Schedule, from: number): number {
  const { h, m } = splitTime(s.time);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function nextWeekly(s: Schedule, from: number): number {
  const { h, m } = splitTime(s.time);
  const target = s.weekday ?? 1;
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  for (let i = 0; i < 8; i++) {
    if (d.getDay() === target && d.getTime() > from) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
  }
  return d.getTime();
}

function nextMonthly(s: Schedule, from: number): number {
  const { h, m } = splitTime(s.time);
  const day = s.day ?? 1;
  const base = new Date(from);
  for (let i = 0; i < 13; i++) {
    const year = base.getFullYear();
    const month = base.getMonth() + i;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const d = new Date(year, month, Math.min(day, lastDay), h, m, 0, 0);
    if (d.getTime() > from) return d.getTime();
  }
  return from + 31 * 86_400_000;
}

export function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case "once":
      return `once at ${s.at ? new Date(s.at).toLocaleString() : "?"}`;
    case "daily":
      return `daily at ${s.time}`;
    case "weekly":
      return `weekly on ${DAY_NAMES[s.weekday ?? 1]} at ${s.time}`;
    case "monthly":
      return `monthly on day ${s.day} at ${s.time}`;
    case "interval":
      return `every ${s.everyMinutes} min`;
    default:
      return "unknown";
  }
}

function fmt(t: { h: number; m: number }): string {
  return `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
}

function splitTime(time?: string): { h: number; m: number } {
  const p = parseTime(time ?? "09:00");
  return p ?? { h: 9, m: 0 };
}
