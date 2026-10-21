import { and, desc, eq } from "drizzle-orm";

import { authorizations, bookings, paypalOrders, technicians, workspaces } from "@/db/schema";
import type { Executor } from "@/db/types";
import { BookingNotFoundError, type Booking } from "@/server/domain/transition";

import { PaymentStateError } from "./context";

export type AuthorizationRow = typeof authorizations.$inferSelect;

export async function getBooking(db: Executor, bookingId: string): Promise<Booking> {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!row) throw new BookingNotFoundError(bookingId);
  return row;
}

/** Sample history is read-only (SPEC §17): no payment step ever touches it. */
export function assertLive(booking: Booking) {
  if (booking.sample) throw new PaymentStateError("Sample bookings are read-only.", 409, "sample");
}

export async function getWorkspace(db: Executor, workspaceId: string) {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!row) throw new Error(`workspace ${workspaceId} not found`);
  return row;
}

export async function getTechnician(db: Executor, technicianId: string) {
  const [row] = await db.select().from(technicians).where(eq(technicians.id, technicianId));
  if (!row) throw new Error(`technician ${technicianId} not found`);
  return row;
}

export async function getAuthorization(db: Executor, id: string): Promise<AuthorizationRow> {
  const [row] = await db.select().from(authorizations).where(eq(authorizations.id, id));
  if (!row) throw new Error(`authorization ${id} not found`);
  return row;
}

/** The authorization captures go to: the newest in the chain (a reauthorized child, SPEC §9.3). */
export async function activeAuthorization(db: Executor, booking: Booking): Promise<AuthorizationRow> {
  if (!booking.activeAuthorizationId) {
    throw new PaymentStateError("This booking has no authorization.", 409, "no_authorization");
  }
  return getAuthorization(db, booking.activeAuthorizationId);
}

/** The authorization voids go to: the chain's parent (a reauthorization can't be voided, SPEC §9.5). */
export async function chainRoot(db: Executor, auth: AuthorizationRow): Promise<AuthorizationRow> {
  return auth.parentAuthorizationId ? getAuthorization(db, auth.parentAuthorizationId) : auth;
}

export async function latestOrder(db: Executor, bookingId: string) {
  const [row] = await db
    .select()
    .from(paypalOrders)
    .where(eq(paypalOrders.bookingId, bookingId))
    .orderBy(desc(paypalOrders.attempt))
    .limit(1);
  return row;
}

export async function orderOf(db: Executor, bookingId: string, paypalOrderId: string) {
  const [row] = await db
    .select()
    .from(paypalOrders)
    .where(and(eq(paypalOrders.bookingId, bookingId), eq(paypalOrders.paypalOrderId, paypalOrderId)));
  return row;
}
