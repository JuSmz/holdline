import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { authorizations, bookingEvents, bookings, paymentOperations, paypalOrders } from "@/db/schema";
import { authorizeBooking, createOrderForBooking } from "@/server/payments/authorize";
import { PaymentStateError } from "@/server/payments/context";
import { runTick } from "@/server/payments/jobs";
import { processWebhookEvent } from "@/server/payments/webhook-processor";

import { bookingById, makeBooking } from "../support/factory";
import {
  authorizedBooking,
  eventRow,
  INSTANCE,
  payBooking,
  paymentHarness,
  pendingBooking,
  resetPayments,
  storeEvent,
} from "../support/payments";

beforeEach(async () => {
  await resetPayments();
});

afterAll(async () => {
  await closeDb();
});

const HOUR = 3_600_000;
const MINUTE = 60_000;

describe("SPEC §24 payment matrix: order and authorize", () => {
  it("#1 creates the order from the snapshot and authorizes it", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    const { orderId, outcome } = await payBooking(h, booking.id);
    expect(outcome.status).toBe("authorized");
    expect(outcome.booking).toMatchObject({ status: "authorized", paymentIssue: null, authorizingUntil: null });
    const [create] = h.fake.calls("POST", /^\/v2\/checkout\/orders$/);
    expect(create.body).toMatchObject({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          custom_id: booking.id,
          invoice_id: `${INSTANCE}-${booking.ref}-1`,
          description: "Holdline hold – Drain cleaning",
          amount: { currency_code: "USD", value: "149.00" },
        },
      ],
    });
    expect(h.fake.calls("POST", /\/authorize$/)).toHaveLength(1);
    const [auth] = await getDb().select().from(authorizations).where(eq(authorizations.bookingId, booking.id));
    expect(auth).toMatchObject({ paypalOrderId: orderId, status: "CREATED", amountCents: 14_900, role: "active" });
    expect(h.notices).toEqual([{ bookingId: booking.id, notice: "authorized" }]);
  });

  it("reuses an open order for the same amount instead of creating another", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    const first = await createOrderForBooking(h.ctx, booking.id);
    const second = await createOrderForBooking(h.ctx, booking.id);
    expect(second.orderId).toBe(first.orderId);
    expect(h.fake.calls("POST", /^\/v2\/checkout\/orders$/)).toHaveLength(1);
  });

  it("#2 a declined authorize keeps the booking pending; a new order then works", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    h.fake.fault("POST", /\/authorize$/, { kind: "http", status: 422, issue: "INSTRUMENT_DECLINED" });
    const declined = await payBooking(h, booking.id);
    expect(declined.outcome.status).toBe("declined_retry");
    expect(declined.outcome.booking.status).toBe("pending_payment");
    expect(h.notices.map((n) => n.notice)).toEqual(["declined_retry"]);

    const retry = await payBooking(h, booking.id);
    expect(retry.orderId).not.toBe(declined.orderId);
    expect(retry.outcome.status).toBe("authorized");
    const orders = await getDb().select().from(paypalOrders).where(eq(paypalOrders.bookingId, booking.id));
    expect(orders.map((o) => [o.attempt, o.status]).sort()).toEqual([
      [1, "DECLINED"],
      [2, "COMPLETED"],
    ]);
  });

  it("#3 a PENDING authorization flags the booking; AUTHORIZATION.CREATED then authorizes it", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    h.fake.next.authorizationStatus.push("PENDING");
    const { outcome } = await payBooking(h, booking.id);
    expect(outcome.status).toBe("processing");
    expect(outcome.booking).toMatchObject({ status: "pending_payment", paymentIssue: "authorization_pending" });
    expect(outcome.booking.holdExpiresAt.getTime()).toBeGreaterThan(h.now().getTime() + 5 * HOUR);
    await expect(createOrderForBooking(h.ctx, booking.id)).rejects.toThrow(PaymentStateError);

    const [auth] = await getDb().select().from(authorizations).where(eq(authorizations.bookingId, booking.id));
    h.fake.settleAuthorization(auth.paypalAuthorizationId, "CREATED");
    const eventId = await storeEvent(
      "PAYMENT.AUTHORIZATION.CREATED",
      { id: auth.paypalAuthorizationId },
      auth.paypalAuthorizationId,
    );
    expect(await processWebhookEvent(h.ctx, eventId)).toBe(true);
    expect(await bookingById(getDb(), booking.id)).toMatchObject({ status: "authorized", paymentIssue: null });
    expect((await eventRow(eventId)).processedAt).not.toBeNull();
  });

  it("#4 a DENIED authorization asks for a new order", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    h.fake.next.authorizationStatus.push("DENIED");
    const first = await payBooking(h, booking.id);
    expect(first.outcome.status).toBe("declined_retry");
    const second = await createOrderForBooking(h.ctx, booking.id);
    expect(second.orderId).not.toBe(first.orderId);
  });

  it("#5 a double click on authorize makes one PayPal call and one transition", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    const results = await Promise.all([
      authorizeBooking(h.ctx, booking.id, orderId),
      authorizeBooking(h.ctx, booking.id, orderId),
      authorizeBooking(h.ctx, booking.id, orderId),
    ]);
    expect(results.map((r) => r.status)).toEqual(["authorized", "authorized", "authorized"]);
    expect(h.fake.calls("POST", /\/authorize$/)).toHaveLength(1);
    const events = await getDb().select().from(bookingEvents).where(eq(bookingEvents.bookingId, booking.id));
    expect(events.filter((e) => e.toStatus === "authorized")).toHaveLength(1);
  });

  it("#9 tab closed after approval: CHECKOUT.ORDER.APPROVED authorizes", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    const eventId = await storeEvent("CHECKOUT.ORDER.APPROVED", { id: orderId }, orderId);
    await processWebhookEvent(h.ctx, eventId);
    expect((await bookingById(getDb(), booking.id)).status).toBe("authorized");
    const [event] = await getDb().select().from(bookingEvents).where(eq(bookingEvents.bookingId, booking.id));
    expect(event.actor).toBe("webhook");
  });

  it("#10 crash after authorize, recovery after the TTL: booking expired, hold voided, nothing leaks", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    // The buyer approves just before the TTL; PayPal authorizes, but every response is lost.
    h.advance(59.5 * MINUTE);
    h.fake.fault("POST", /\/authorize$/, { kind: "lostResponse" }, 3);
    expect((await authorizeBooking(h.ctx, booking.id, orderId)).status).toBe("processing");
    expect(h.fake.authorizations.size).toBe(1);

    // TTL passed, the lease is still live: the TTL job leaves the booking alone.
    h.advance(45_000);
    await runTick(h.ctx, getDb(), h.now());
    expect((await bookingById(getDb(), booking.id)).status).toBe("pending_payment");

    // The worker never came back; the reconciler takes over only after TTL + grace.
    h.advance(15 * MINUTE);
    await runTick(h.ctx, getDb(), h.now());
    expect((await bookingById(getDb(), booking.id)).status).toBe("expired");
    const [auth] = await getDb().select().from(authorizations).where(eq(authorizations.bookingId, booking.id));
    expect(auth).toMatchObject({ role: "orphan", status: "VOIDED" });
    expect([...h.fake.authorizations.values()].map((a) => a.status)).toEqual(["VOIDED"]);
    expect(h.fake.calls("POST", /\/authorize$/)).toHaveLength(3); // one request ID, replayed by PayPal
    expect(h.fake.calls("POST", /\/void$/)).toHaveLength(1);
  });

  it("#10 recovery inside the grace period authorizes as normal", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    h.fake.fault("POST", /\/authorize$/, { kind: "lostResponse" }, 3);
    expect((await authorizeBooking(h.ctx, booking.id, orderId)).status).toBe("processing");
    h.advance(2 * MINUTE);
    await runTick(h.ctx, getDb(), h.now());
    expect((await bookingById(getDb(), booking.id)).status).toBe("authorized");
    expect(h.fake.authorizations.size).toBe(1);
    expect(h.fake.calls("POST", /\/void$/)).toHaveLength(0);
  });

  it("#10 TTL wins first: a later approve is rejected without any authorize call", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.advance(61 * MINUTE);
    await runTick(h.ctx, getDb(), h.now()); // order still PAYER_ACTION_REQUIRED → expired
    expect((await bookingById(getDb(), booking.id)).status).toBe("expired");
    h.fake.approve(orderId);
    const late = await authorizeBooking(h.ctx, booking.id, orderId);
    expect(late.status).toBe("expired");
    expect(h.fake.calls("POST", /\/authorize$/)).toHaveLength(0);
  });

  it("#10 an order approved before the TTL may still be authorized inside the 10-minute grace", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    h.advance(65 * MINUTE);
    expect((await authorizeBooking(h.ctx, booking.id, orderId)).status).toBe("authorized");
  });

  it("#11 an amount mismatch voids exactly once and raises", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    h.fake.orders.get(orderId)!.amountCents = 100; // PayPal authorizes $1.00 instead of $149.00
    await expect(authorizeBooking(h.ctx, booking.id, orderId)).rejects.toMatchObject({ code: "amount_mismatch" });
    expect(h.fake.calls("POST", /\/void$/)).toHaveLength(1);
    expect((await bookingById(getDb(), booking.id)).status).toBe("pending_payment");
    const [auth] = await getDb().select().from(authorizations).where(eq(authorizations.bookingId, booking.id));
    expect(auth.role).toBe("orphan");
    // A second report of the same authorization does not void again.
    await expect(authorizeBooking(h.ctx, booking.id, orderId)).rejects.toThrow();
    expect(h.fake.calls("POST", /\/void$/)).toHaveLength(1);
  });

  it("#20 unpaid TTL expires the booking, releases the slot and tells the call", async () => {
    const h = paymentHarness();
    const { ws, booking } = await pendingBooking(h);
    h.advance(61 * MINUTE);
    const report = await runTick(h.ctx, getDb(), h.now());
    expect(report.expire_unpaid).toBe(1);
    expect(await bookingById(getDb(), booking.id)).toMatchObject({ status: "expired", cancelReason: "ttl" });
    expect(h.notices).toEqual([{ bookingId: booking.id, notice: "expired" }]);
    // The slot is free again for the same technician and start.
    const again = await makeBooking(getDb(), ws.id, { slotStart: booking.slotStart });
    expect(again.status).toBe("pending_payment");
    await expect(createOrderForBooking(h.ctx, booking.id)).rejects.toMatchObject({ code: "expired" });
  });

  it("refuses to pay sample history and orders of another booking", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    const other = await pendingBooking(h);
    const [order] = await getDb().select().from(paypalOrders).where(eq(paypalOrders.bookingId, booking.id));
    await expect(authorizeBooking(h.ctx, other.booking.id, order.paypalOrderId)).rejects.toMatchObject({
      code: "unknown_order",
    });
    await getDb().update(bookings).set({ sample: true }).where(eq(bookings.id, other.booking.id));
    await expect(createOrderForBooking(h.ctx, other.booking.id)).rejects.toMatchObject({ code: "sample" });
  });

  it("#29 every POST carries an instance-prefixed PayPal-Request-Id", async () => {
    const h = paymentHarness();
    await authorizedBooking(h);
    const posts = h.fake.requests.filter((r) => r.method === "POST");
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(post.requestId).toMatch(new RegExp(`^${INSTANCE}:`));
    const ops = await getDb().select().from(paymentOperations);
    expect(ops.filter((o) => o.paypalRequestId?.startsWith(`${INSTANCE}:`)).length).toBeGreaterThan(0);
  });
});
