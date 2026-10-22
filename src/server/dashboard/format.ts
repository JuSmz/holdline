import { localDate } from "@/server/domain/time";
import { formatUsd } from "@/server/money";

/**
 * Owner-facing time and money labels (docs/design-system.md). Everything is shown in the business's
 * own time zone, and computed on the server so the first render and every poll say the same thing.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function fmt(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, ...options });
    formatters.set(key, f);
  }
  return f;
}

const MINUTE = 60_000;

/** "9:00 AM". */
export function clockLabel(at: Date, timeZone: string): string {
  return fmt(timeZone, { hour: "numeric", minute: "2-digit" }).format(at);
}

/** "Oct 21" (or "Oct 21, 2025" in another year). */
export function dateLabel(at: Date, now: Date, timeZone: string): string {
  const sameYear = localDate(at, timeZone).slice(0, 4) === localDate(now, timeZone).slice(0, 4);
  return fmt(timeZone, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(at);
}

/**
 * When something happened: "Just now", "12 min ago", "9:00 AM" today, otherwise "Oct 21, 9:00 PM".
 */
export function momentLabel(at: Date, now: Date, timeZone: string): string {
  const ago = now.getTime() - at.getTime();
  if (ago > -MINUTE && ago < MINUTE) return "Just now";
  if (ago > 0 && ago < 60 * MINUTE) return `${Math.floor(ago / MINUTE)} min ago`;
  if (localDate(at, timeZone) === localDate(now, timeZone)) return clockLabel(at, timeZone);
  return `${dateLabel(at, now, timeZone)}, ${clockLabel(at, timeZone)}`;
}

/** "Today", "Tomorrow", "Yesterday" or "Thu, Oct 22". */
export function dayLabel(at: Date, now: Date, timeZone: string): string {
  const day = localDate(at, timeZone);
  const today = localDate(now, timeZone);
  const shift = (days: number) => localDate(new Date(now.getTime() + days * 24 * 60 * MINUTE), timeZone);
  if (day === today) return "Today";
  if (day === shift(1)) return "Tomorrow";
  if (day === shift(-1)) return "Yesterday";
  return `${fmt(timeZone, { weekday: "short" }).format(at)}, ${dateLabel(at, now, timeZone)}`;
}

/** An appointment: { day: "Thu, Oct 22", time: "10:00 AM – 12:00 PM CT" }. */
export function appointmentLabel(start: Date, end: Date, now: Date, timeZone: string, zone = "CT") {
  return {
    day: dayLabel(start, now, timeZone),
    time: `${clockLabel(start, timeZone)} – ${clockLabel(end, timeZone)} ${zone}`,
  };
}

/** "3 min 4 s", "45 s". */
export function durationLabel(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const usd = formatUsd;

/** "Maya Torres" → "Maya"; "Sample: Dana K." → "Dana". */
export function firstName(name: string | null | undefined): string {
  return (
    (name ?? "")
      .replace(/^Sample:\s*/, "")
      .trim()
      .split(/\s+/)[0] || "—"
  );
}
