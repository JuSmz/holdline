import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { bookings } from "@/db/schema";
import { MAIN_WORKSPACE_ID } from "@/db/seed";
import { PaymentStateError } from "@/server/payments/context";

/** The lab acts only on live bookings of the owner's main workspace. */
export async function labBooking(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new PaymentStateError("Booking not found.", 404, "not_found");
  const [row] = await getDb()
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, id), eq(bookings.workspaceId, MAIN_WORKSPACE_ID), eq(bookings.sample, false)));
  if (!row) throw new PaymentStateError("Booking not found.", 404, "not_found");
  return row;
}
