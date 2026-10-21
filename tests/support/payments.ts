import { eq, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { webhookEvents } from "@/db/schema";
import { authorizeBooking, createOrderForBooking } from "@/server/payments/authorize";
import type { CallNotice, PaymentContext } from "@/server/payments/context";
import { PayPalClient } from "@/server/paypal/client";
import { FakePayPal } from "@/server/paypal/mock/fake-paypal";

import { makeBooking, makeWorkspace } from "./factory";

export const INSTANCE = "t-pay";

/**
 * The job runner sweeps whole tables (as in production), so payment tests start from empty payment
 * tables. Integration files run one after another, so this never races another test.
 */
export async function resetPayments() {
  await getDb().execute(
    sql`truncate webhook_events, payment_operations, payouts, invoices, captures, authorizations, paypal_orders, booking_events, call_notifications, pay_tokens, booking_claims, bookings, customers cascade`,
  );
}

/** A payment context on the fake PayPal with a movable clock. */
export function paymentHarness(start: Date = new Date()) {
  let clock = start;
  const fake = new FakePayPal({ now: () => clock });
  const paypal = new PayPalClient({
    clientId: "test-id",
    clientSecret: "test-secret",
    instanceId: INSTANCE,
    fetch: fake.fetch,
    sleep: async () => {},
    random: () => 0,
  });
  const notices: { bookingId: string; notice: CallNotice }[] = [];
  const ctx: PaymentContext = {
    db: getDb(),
    paypal,
    now: () => clock,
    notify: (bookingId, notice) => notices.push({ bookingId, notice }),
  };
  return {
    fake,
    paypal,
    ctx,
    notices,
    now: () => clock,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    set(at: Date) {
      clock = at;
    },
  };
}

export type Harness = ReturnType<typeof paymentHarness>;

/** A fresh workspace and a pending booking `daysAhead` from the harness clock. */
export async function pendingBooking(h: Harness, options: { daysAhead?: number; serviceKey?: string } = {}) {
  const db = getDb();
  const ws = await makeWorkspace(db);
  const booking = await makeBooking(db, ws.id, { now: h.now(), ...options });
  return { ws, booking };
}

/** Order → buyer approves → authorize, as the pay panel does. */
export async function payBooking(h: Harness, bookingId: string) {
  const { orderId } = await createOrderForBooking(h.ctx, bookingId);
  h.fake.approve(orderId);
  const outcome = await authorizeBooking(h.ctx, bookingId, orderId);
  return { orderId, outcome };
}

export async function authorizedBooking(h: Harness, options: { daysAhead?: number; serviceKey?: string } = {}) {
  const { ws, booking } = await pendingBooking(h, options);
  const { orderId, outcome } = await payBooking(h, booking.id);
  if (outcome.status !== "authorized") throw new Error(`expected authorized, got ${outcome.status}`);
  return { ws, booking: outcome.booking, orderId };
}

let eventSeq = 0;

/** Stores a verified PayPal event as the webhook route would, and returns its row ID. */
export async function storeEvent(eventType: string, resource: Record<string, unknown>, resourceId: string) {
  eventSeq += 1;
  const [row] = await getDb()
    .insert(webhookEvents)
    .values({
      paypalEventId: `WH-TEST-${Date.now()}-${eventSeq}-${Math.random().toString(36).slice(2, 8)}`,
      eventType,
      resourceType: "test",
      resourceId,
      raw: { event_type: eventType, resource },
      verifiedVia: "offline",
    })
    .returning();
  return row.id;
}

export async function eventRow(id: string) {
  const [row] = await getDb().select().from(webhookEvents).where(eq(webhookEvents.id, id));
  return row;
}
