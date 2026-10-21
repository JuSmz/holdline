import type { WorkingHours } from "@/db/schema";
import { sign, verify } from "@/server/security/tokens";

import { addDays, isoWeekday, localDate, localHour, slotLabel, zonedToUtc } from "./time";

/** Arrival windows are two hours long, one job per technician per window. */
export const WINDOW_MINUTES = 120;
/** No slot starts sooner than this from now. */
export const LEAD_MINUTES = 60;
/** A signed slot ID lives at most 30 minutes (SPEC §9.1). */
export const SLOT_TOKEN_TTL_SECONDS = 30 * 60;

export type TechnicianForSlots = {
  id: string;
  name: string;
  skills: readonly string[];
  workingHours: WorkingHours;
  active: boolean;
};

export type Slot = { technicianId: string; technicianFirstName: string; start: Date; end: Date; label: string };

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** The arrival windows of one technician on one local date, as UTC instants. */
export function windowsOn(hours: WorkingHours, date: string, timeZone: string): { start: Date; end: Date }[] {
  const intervals = hours[String(isoWeekday(date)) as keyof WorkingHours] ?? [];
  const windows: { start: Date; end: Date }[] = [];
  for (const [open, close] of intervals) {
    for (let t = toMinutes(open); t + WINDOW_MINUTES <= toMinutes(close); t += WINDOW_MINUTES) {
      windows.push({
        start: zonedToUtc(date, toHhmm(t), timeZone),
        end: zonedToUtc(date, toHhmm(t + WINDOW_MINUTES), timeZone),
      });
    }
  }
  return windows;
}

export type FindSlotsInput = {
  category: string;
  technicians: TechnicianForSlots[];
  /** Slots already held by live bookings (SPEC §8.4.5). */
  busy: { technicianId: string; slotStart: Date }[];
  timeZone: string;
  now: Date;
  bookingWindowDays: number;
  /** Local date, YYYY-MM-DD. Earlier dates are moved to today. */
  preferredDate: string;
  timeOfDay?: "morning" | "afternoon" | "any";
  limit?: number;
};

/** Up to `limit` free slots, starting on the preferred date and moving forward within the booking window. */
export function findSlots(input: FindSlotsInput): Slot[] {
  const limit = input.limit ?? 3;
  const today = localDate(input.now, input.timeZone);
  const lastDay = addDays(today, input.bookingWindowDays);
  const earliest = input.now.getTime() + LEAD_MINUTES * 60_000;
  const busy = new Set(input.busy.map((b) => `${b.technicianId}@${b.slotStart.getTime()}`));
  const techs = input.technicians.filter((t) => t.active && t.skills.includes(input.category));
  const slots: Slot[] = [];

  for (let date = input.preferredDate < today ? today : input.preferredDate; date <= lastDay; date = addDays(date, 1)) {
    const taken = new Set<number>();
    const candidates: Slot[] = [];
    for (const tech of techs) {
      for (const w of windowsOn(tech.workingHours, date, input.timeZone)) {
        if (w.start.getTime() < earliest || taken.has(w.start.getTime())) continue;
        if (busy.has(`${tech.id}@${w.start.getTime()}`)) continue;
        const hour = localHour(w.start, input.timeZone);
        if (input.timeOfDay === "morning" && hour >= 12) continue;
        if (input.timeOfDay === "afternoon" && hour < 12) continue;
        taken.add(w.start.getTime());
        candidates.push({
          technicianId: tech.id,
          technicianFirstName: tech.name.split(" ")[0],
          start: w.start,
          end: w.end,
          label: slotLabel(w.start, w.end, input.timeZone),
        });
      }
    }
    candidates.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (const c of candidates) {
      slots.push(c);
      if (slots.length >= limit) return slots;
    }
  }
  return slots;
}

type SlotClaims = { ws: string; svc: string; tech: string; start: number };

/** A slot ID bound to {workspace, service, technician, start}, valid ≤ 30 minutes (SPEC §9.1, §20). */
export function slotId(
  slot: { technicianId: string; start: Date },
  scope: { workspaceId: string; serviceId: string },
  now?: Date,
) {
  return sign(
    "slot",
    { ws: scope.workspaceId, svc: scope.serviceId, tech: slot.technicianId, start: slot.start.getTime() },
    SLOT_TOKEN_TTL_SECONDS,
    { now },
  );
}

/** The slot behind a slot ID, or null if it is forged, expired, or bound to another workspace or service. */
export function readSlotId(
  token: string,
  scope: { workspaceId: string; serviceId: string },
  now?: Date,
): { technicianId: string; start: Date } | null {
  const claims = verify<SlotClaims>("slot", token, { now });
  if (!claims || claims.ws !== scope.workspaceId || claims.svc !== scope.serviceId) return null;
  if (typeof claims.tech !== "string" || typeof claims.start !== "number") return null;
  return { technicianId: claims.tech, start: new Date(claims.start) };
}
