import { and, eq, gt, inArray, or } from "drizzle-orm";

import { bookings, customers, services, technicians, workspaces } from "@/db/schema";
import type { Executor } from "@/db/types";

import { findSlots, LEAD_MINUTES, type Slot } from "./availability";
import { policyOf } from "./policy";
import { priceSnapshot } from "./pricing";
import { newBookingRef } from "./refs";
import { addDays, localDate } from "./time";
import type { Booking } from "./transition";

export class BookingInputError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_service" | "unknown_technician" | "slot_unavailable" | "slot_taken",
    readonly status = 409,
  ) {
    super(message);
    this.name = "BookingInputError";
  }
}

/** Slots held by live bookings (SPEC §8.4.5): authorized, cancelled-not-yet-voided, and pending within TTL. */
export async function busySlots(db: Executor, workspaceId: string, now: Date) {
  return db
    .select({ technicianId: bookings.technicianId, slotStart: bookings.slotStart })
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, workspaceId),
        eq(bookings.sample, false),
        or(
          inArray(bookings.status, ["authorized", "cancelled"]),
          and(
            eq(bookings.status, "pending_payment"),
            or(gt(bookings.holdExpiresAt, now), gt(bookings.authorizingUntil, now)),
          ),
        ),
      ),
    );
}

/** Free slots for a service (the `check_availability` core, SPEC §13.2). */
export async function freeSlots(
  db: Executor,
  input: {
    workspaceId: string;
    serviceId: string;
    preferredDate?: string;
    timeOfDay?: "morning" | "afternoon" | "any";
    now: Date;
    limit?: number;
  },
): Promise<Slot[]> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId));
  const [service] = await db
    .select()
    .from(services)
    .where(
      and(eq(services.id, input.serviceId), eq(services.workspaceId, input.workspaceId), eq(services.active, true)),
    );
  if (!ws || !service) throw new BookingInputError("Unknown service.", "unknown_service", 404);
  const techs = await db.select().from(technicians).where(eq(technicians.workspaceId, input.workspaceId));
  return findSlots({
    category: service.category,
    technicians: techs,
    busy: await busySlots(db, input.workspaceId, input.now),
    timeZone: ws.timezone,
    now: input.now,
    bookingWindowDays: policyOf(ws.policy).bookingWindowDays,
    preferredDate: input.preferredDate ?? addDays(localDate(input.now, ws.timezone), 1),
    timeOfDay: input.timeOfDay ?? "any",
    limit: input.limit ?? 3,
  });
}

export type NewBooking = {
  workspaceId: string;
  serviceId: string;
  technicianId: string;
  slotStart: Date;
  customer: { name: string; email: string; phone?: string | null; address?: string | null };
  problemSummary?: string | null;
  urgency?: "emergency" | "soon" | "flexible";
  callId?: string | null;
  now: Date;
};

/**
 * Creates a pending_payment booking with the price snapshot from the catalog (SPEC §9.1). The slot must
 * be one `freeSlots` would offer right now; the live-slot index settles a race for the same slot.
 */
export async function createPendingBooking(db: Executor, input: NewBooking): Promise<Booking> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId));
  const [service] = await db
    .select()
    .from(services)
    .where(
      and(eq(services.id, input.serviceId), eq(services.workspaceId, input.workspaceId), eq(services.active, true)),
    );
  if (!ws || !service) throw new BookingInputError("Unknown service.", "unknown_service", 404);
  const [tech] = await db
    .select()
    .from(technicians)
    .where(and(eq(technicians.id, input.technicianId), eq(technicians.workspaceId, input.workspaceId)));
  if (!tech || !tech.active || !tech.skills.includes(service.category)) {
    throw new BookingInputError("Unknown technician.", "unknown_technician", 404);
  }
  if (input.slotStart.getTime() < input.now.getTime() + LEAD_MINUTES * 60_000) {
    throw new BookingInputError("That time is no longer available.", "slot_unavailable");
  }
  const offered = await freeSlots(db, {
    workspaceId: input.workspaceId,
    serviceId: input.serviceId,
    preferredDate: localDate(input.slotStart, ws.timezone),
    now: input.now,
    limit: 50,
  });
  const slot = offered.find((s) => s.technicianId === tech.id && s.start.getTime() === input.slotStart.getTime());
  if (!slot) throw new BookingInputError("That time is no longer available.", "slot_unavailable");

  const policy = policyOf(ws.policy);
  const snapshot = priceSnapshot(service);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const [customer] = await tx
          .insert(customers)
          .values({
            workspaceId: input.workspaceId,
            name: input.customer.name,
            email: input.customer.email,
            phone: input.customer.phone ?? null,
            address: input.customer.address ?? null,
          })
          .returning();
        const [booking] = await tx
          .insert(bookings)
          .values({
            workspaceId: input.workspaceId,
            ref: newBookingRef(),
            serviceId: service.id,
            technicianId: tech.id,
            customerId: customer.id,
            callId: input.callId ?? null,
            slotStart: slot.start,
            slotEnd: slot.end,
            ...snapshot,
            problemSummary: input.problemSummary ?? null,
            urgency: input.urgency ?? "flexible",
            holdExpiresAt: new Date(input.now.getTime() + policy.holdTtlMinutes * 60_000),
          })
          .returning();
        return booking;
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
      if (cause?.code === "23505" && cause.constraint_name === "bookings_live_slot_uq") {
        throw new BookingInputError("Someone just took that time.", "slot_taken");
      }
      if (cause?.code === "23505" && cause.constraint_name === "bookings_ref_unique" && attempt < 5) continue;
      throw error;
    }
  }
}
