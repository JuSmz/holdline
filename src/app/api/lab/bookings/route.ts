import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/db/client";
import { services } from "@/db/schema";
import { MAIN_WORKSPACE_ID } from "@/db/seed";
import { createPendingBooking, freeSlots } from "@/server/domain/bookings";
import { DATE_PATTERN } from "@/server/domain/time";
import { labApiGuard } from "@/server/lab";
import { PaymentStateError } from "@/server/payments/context";
import { paymentErrorResponse } from "@/server/payments/http";

export const dynamic = "force-dynamic";

const input = z.object({
  serviceKey: z.string().regex(/^[a-z0-9-]{1,40}$/),
  preferredDate: z.string().regex(DATE_PATTERN).optional(),
  // Sandbox buyers only: invoices go to this address.
  payerEmail: z
    .string()
    .email()
    .max(120)
    .refine((e) => e.toLowerCase().endsWith(".example.com"), "sandbox (*.example.com) addresses only"),
});

/** Creates a lab booking in the main workspace on the next free slot (stage 6 lab, PLAN). */
export async function POST(request: Request) {
  const denied = await labApiGuard(request);
  if (denied) return denied;
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: "invalid_input", message: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  }
  try {
    const db = getDb();
    const now = new Date();
    const [service] = await db
      .select()
      .from(services)
      .where(and(eq(services.workspaceId, MAIN_WORKSPACE_ID), eq(services.key, parsed.data.serviceKey)));
    if (!service) throw new PaymentStateError("Unknown service.", 404, "unknown_service");
    const [slot] = await freeSlots(db, {
      workspaceId: MAIN_WORKSPACE_ID,
      serviceId: service.id,
      preferredDate: parsed.data.preferredDate,
      now,
    });
    if (!slot) throw new PaymentStateError("No free slot in the booking window.", 409, "no_slot");
    const booking = await createPendingBooking(db, {
      workspaceId: MAIN_WORKSPACE_ID,
      serviceId: service.id,
      technicianId: slot.technicianId,
      slotStart: slot.start,
      customer: { name: "Lab buyer", email: parsed.data.payerEmail, address: "Lab address, Austin TX" },
      problemSummary: "Lab booking",
      now,
    });
    return Response.json({ ok: true, booking: { id: booking.id, ref: booking.ref, slot: slot.label } });
  } catch (error) {
    return paymentErrorResponse(error);
  }
}
