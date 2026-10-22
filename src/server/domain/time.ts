/**
 * Wall-clock helpers for a workspace timezone (SPEC §7: the demo uses America/Chicago), built on Intl
 * so they follow the US DST change on 2026-11-01 without a date library.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function wallClock(instant: Date, timeZone: string) {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

/** Local wall time minus UTC, in ms, at `instant`. */
function offsetMs(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which `timeZone` shows `date` (YYYY-MM-DD) `time` (HH:MM). */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = offsetMs(new Date(guess), timeZone);
  const second = offsetMs(new Date(guess - first), timeZone);
  return new Date(guess - (first === second ? first : second));
}

/** The local calendar date (YYYY-MM-DD) of `instant`. */
export function localDate(instant: Date, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** Local hour (0–23) of `instant`. */
export function localHour(instant: Date, timeZone: string): number {
  return wallClock(instant, timeZone).h;
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** "Thu Oct 22, 10:00–12:00 CT" — times are always stated in the workspace's zone (SPEC §13.1). */
export function slotLabel(start: Date, end: Date, timeZone: string, zoneLabel = "CT"): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(
    start,
  );
  const time = (t: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
  return `${day}, ${time(start)}–${time(end)} ${zoneLabel}`;
}

/** "Thursday, October 22, 10 AM to 12 PM Austin time": the spoken form for the confirmation (SPEC §16). */
export function spokenSlot(start: Date, end: Date, timeZone: string, place = "Austin"): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" }).format(
    start,
  );
  const time = (t: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true })
      .format(t)
      .replace(":00", "");
  return `${day}, ${time(start)} to ${time(end)} ${place} time`;
}
