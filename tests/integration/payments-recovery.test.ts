import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { authorizations, bookings, captures, invoices, paymentOperations, payouts } from "@/db/schema";
import { transitionBooking } from "@/server/domain/transition";
import { authorizeBooking, createOrderForBooking } from "@/server/payments/authorize";
import { markJobDone, markNoShow, retryCapture } from "@/server/payments/capture";
import { billViaInvoice } from "@/server/payments/invoices";
import { runTick } from "@/server/payments/jobs";
import { runOperation } from "@/server/payments/ledger";
import { retryPayout } from "@/server/payments/payouts";
import { cancelBooking, waiveFee } from "@/server/payments/void";
import { processWebhookEvent } from "@/server/payments/webhook-processor";
import { captureAuthorization } from "@/server/paypal/payments";
import { createPayout } from "@/server/paypal/payouts";

import { bookingById } from "../support/factory";
import { authorizedBooking, paymentHarness, pendingBooking, resetPayments, storeEvent } from "../support/payments";

beforeEach(async () => {
  await resetPayments();
  vi.stubEnv("PAYPAL_BUSINESS_EMAIL", "merchant@business.example.com");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

const MINUTE = 60_000;
const db = () => getDb();

async function authRow(bookingId: string) {
  const [row] = await db().select().from(authorizations).where(eq(authorizations.bookingId, bookingId));
  return row;
}

describe("recovery after a crash between PayPal's answer and our write", () => {
  it("re-applies a capture whose ledger row succeeded but whose booking never moved", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    const auth = await authRow(booking.id);
    await db().transaction((tx) =>
      transitionBooking(tx, { bookingId: booking.id, from: "authorized", to: "completed", actor: "owner" }),
    );
    // The process captures at PayPal, records the ledger result, then dies before applyCapture.
    const requestId = h.paypal.requestId("capture", "full", booking.id);
    await runOperation(db(), {
      key: `capture:full:${booking.id}`,
      kind: "capture",
      bookingId: booking.id,
      requestId,
      now: h.ctx.now,
      run: async () => {
        const c = await captureAuthorization(h.paypal, auth.paypalAuthorizationId, {
          requestId,
          amountCents: booking.priceCents,
          currency: "USD",
          finalCapture: true,
          invoiceId: `t-pay-${booking.ref}`,
        });
        return {
          paypalCaptureId: c.id,
          status: c.status,
          amountCents: 14_900,
          finalCapture: true,
          authorizationId: auth.id,
        };
      },
    });
    expect((await bookingById(db(), booking.id)).status).toBe("completed");

    h.advance(MINUTE);
    await runTick(h.ctx, db(), h.now());
    expect(await db().select().from(captures).where(eq(captures.bookingId, booking.id))).toHaveLength(1);
    expect((await bookingById(db(), booking.id)).status).toBe("paid_out");
    expect(h.fake.captures.size).toBe(1);
    const [op] = await db()
      .select()
      .from(paymentOperations)
      .where(eq(paymentOperations.key, `capture:full:${booking.id}`));
    expect(op.appliedAt).not.toBeNull();
  });

  it("re-applies a payout batch PayPal accepted but we never recorded; no second batch", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    await getDb().execute(`update technicians set payout_email = null where id = '${booking.technicianId}'`);
    await markJobDone(h.ctx, booking.id); // payout row created, not sent (no email yet)
    await getDb().execute(
      `update technicians set payout_email = 'maya@personal.example.com' where id = '${booking.technicianId}'`,
    );
    const [row] = await db().select().from(payouts).where(eq(payouts.bookingId, booking.id));
    await runOperation(db(), {
      key: `payout:${row.id}`,
      kind: "payout",
      bookingId: booking.id,
      requestId: h.paypal.requestId("payout", row.senderItemId),
      now: h.ctx.now,
      run: async () => {
        const created = await createPayout(h.paypal, {
          senderBatchId: row.senderBatchId,
          senderItemId: row.senderItemId,
          receiverEmail: "maya@personal.example.com",
          amountCents: row.amountCents,
          currency: "USD",
          note: "x",
          emailSubject: "x",
          emailMessage: "x",
        });
        return { payoutBatchId: created.payoutBatchId };
      },
    });
    h.advance(MINUTE);
    await runTick(h.ctx, db(), h.now());
    expect(h.fake.payoutBatches.size).toBe(1);
    expect((await bookingById(db(), booking.id)).status).toBe("paid_out");
  });
});

describe("a failed lookup never settles an operation", () => {
  it("a 429 on the recovery GET keeps the capture unknown; it recovers once PayPal answers", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.fault("POST", /\/capture$/, { kind: "lostResponse" }, 3);
    expect((await markJobDone(h.ctx, booking.id)).status).toBe("processing");
    h.fake.fault("GET", /^\/v2\/checkout\/orders\//, { kind: "http", status: 429, name: "RATE_LIMIT_REACHED" }, 3);
    h.advance(2 * MINUTE);
    await runTick(h.ctx, db(), h.now());
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "completed", paymentIssue: null });
    const [op] = await db()
      .select()
      .from(paymentOperations)
      .where(eq(paymentOperations.key, `capture:full:${booking.id}`));
    expect(op.state).toBe("in_flight");
    await expect(billViaInvoice(h.ctx, booking.id)).rejects.toThrow();

    h.advance(10 * MINUTE);
    await runTick(h.ctx, db(), h.now());
    expect((await bookingById(db(), booking.id)).status).toBe("paid_out");
    expect(h.fake.captures.size).toBe(1);
    expect(h.fake.invoices.size).toBe(0);
  });
});

describe("Retry capture vs Bill via invoice", () => {
  it("never both captures and invoices, even when clicked together", async () => {
    for (let round = 0; round < 3; round += 1) {
      await resetPayments();
      const h = paymentHarness();
      const { booking } = await authorizedBooking(h);
      h.fake.next.captureStatus.push("DECLINED");
      await markJobDone(h.ctx, booking.id);
      const results = await Promise.allSettled([retryCapture(h.ctx, booking.id), billViaInvoice(h.ctx, booking.id)]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      const completed = [...h.fake.captures.values()].filter((c) => c.status === "COMPLETED");
      const sent = [...h.fake.invoices.values()].filter((i) => i.status === "SENT");
      expect(completed.length + sent.length).toBe(1);
    }
  });

  it("refuses to invoice money PayPal already captured and drops the draft", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    const auth = await authRow(booking.id);
    // PayPal has the money (captured outside our records), but our booking says capture_failed.
    await captureAuthorization(h.paypal, auth.paypalAuthorizationId, {
      requestId: h.paypal.requestId("manual", booking.id),
      amountCents: booking.priceCents,
      currency: "USD",
      finalCapture: true,
    });
    await db().transaction((tx) =>
      transitionBooking(tx, {
        bookingId: booking.id,
        from: "authorized",
        to: "completed",
        actor: "owner",
        flag: "capture_failed",
      }),
    );
    await expect(billViaInvoice(h.ctx, booking.id)).rejects.toThrow("already captured");
    const [row] = await db().select().from(invoices).where(eq(invoices.bookingId, booking.id));
    expect(row.status).toBe("cancelled");
    expect(h.fake.invoices.size).toBe(0);
  });
});

describe("fees, waivers and repeats", () => {
  it("Waive fee is refused while a fallback invoice is open", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.next.captureStatus.push("DECLINED");
    await markNoShow(h.ctx, booking.id);
    await billViaInvoice(h.ctx, booking.id);
    await expect(waiveFee(h.ctx, booking.id)).rejects.toMatchObject({ code: "invoice_open" });
  });

  it("a repeated Cancel returns the earlier result instead of a 409", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h, { daysAhead: 5 });
    const first = await cancelBooking(h.ctx, booking.id);
    const again = await cancelBooking(h.ctx, booking.id);
    expect(again).toMatchObject({ status: "voided", rule: "free_void" });
    expect(first.status).toBe("voided");
    expect(h.fake.calls("POST", /\/void$/)).toHaveLength(1);
  });
});

describe("holds that settle without a webhook", () => {
  it("polls a PENDING authorization and authorizes the booking once it settles", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    h.fake.next.authorizationStatus.push("PENDING");
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    expect((await authorizeBooking(h.ctx, booking.id, orderId)).status).toBe("processing");
    h.fake.settleAuthorization((await authRow(booking.id)).paypalAuthorizationId, "CREATED");
    await runTick(h.ctx, db(), h.now());
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "authorized", paymentIssue: null });
  });

  it("chases an approved re-approval order when the buyer's tab closed", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    const old = await authRow(booking.id);
    h.fake.voidExternally(old.paypalAuthorizationId);
    await processWebhookEvent(
      h.ctx,
      await storeEvent("PAYMENT.AUTHORIZATION.VOIDED", { id: old.paypalAuthorizationId }, old.paypalAuthorizationId),
    );
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId); // no onApprove arrives
    await runTick(h.ctx, db(), h.now());
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "authorized", paymentIssue: null });
  });

  it("a declined re-approval is reported as declined, not authorized", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    const old = await authRow(booking.id);
    h.fake.voidExternally(old.paypalAuthorizationId);
    await processWebhookEvent(
      h.ctx,
      await storeEvent("PAYMENT.AUTHORIZATION.VOIDED", { id: old.paypalAuthorizationId }, old.paypalAuthorizationId),
    );
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    h.fake.fault("POST", /\/authorize$/, { kind: "http", status: 422, issue: "INSTRUMENT_DECLINED" });
    expect((await authorizeBooking(h.ctx, booking.id, orderId)).status).toBe("declined_retry");
  });
});

describe("reauthorization with a lost response", () => {
  it("links the child from its webhook; capture goes to the child, nothing voids it", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h, { daysAhead: 10 });
    const parent = await authRow(booking.id);
    h.fake.fault("POST", /\/reauthorize$/, { kind: "lostResponse" }, 3);
    h.set(new Date(parent.reauthorizeAt!.getTime() + MINUTE));
    await runTick(h.ctx, db(), h.now());
    const child = [...h.fake.authorizations.values()].find((a) => a.parentId === parent.paypalAuthorizationId)!;
    expect(child).toBeTruthy();
    await processWebhookEvent(h.ctx, await storeEvent("PAYMENT.AUTHORIZATION.CREATED", { id: child.id }, child.id));
    const linked = await bookingById(db(), booking.id);
    const [childRow] = await db()
      .select()
      .from(authorizations)
      .where(eq(authorizations.paypalAuthorizationId, child.id));
    expect(linked.activeAuthorizationId).toBe(childRow.id);
    expect(childRow).toMatchObject({ parentAuthorizationId: parent.id, role: "active" });
    h.advance(2 * MINUTE);
    await runTick(h.ctx, db(), h.now());
    await markJobDone(h.ctx, booking.id);
    expect(h.fake.calls("POST", /\/capture$/)[0].path).toContain(child.id);
    expect(h.fake.calls("POST", /\/void$/)).toHaveLength(0);
  });
});

describe("payouts", () => {
  it("an UNCLAIMED item claimed before Retry ends succeeded, without a second attempt", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.next.payoutItemStatus.push("UNCLAIMED");
    await markJobDone(h.ctx, booking.id);
    await runTick(h.ctx, db(), h.now());
    const [first] = await db().select().from(payouts).where(eq(payouts.bookingId, booking.id));
    expect(first.status).toBe("unclaimed");
    h.fake.setPayoutItemStatus(first.paypalItemId!, "SUCCESS"); // the recipient claims it
    await expect(retryPayout(h.ctx, first.id)).rejects.toMatchObject({ code: "payout_not_failed" });
    const rows = await db().select().from(payouts).where(eq(payouts.bookingId, booking.id));
    expect(rows).toMatchObject([{ attemptNo: 1, status: "succeeded" }]);
    expect((await bookingById(db(), booking.id)).status).toBe("paid_out");
  });
});

describe("refund events", () => {
  it("resolves the capture through the refund's up link", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    await markJobDone(h.ctx, booking.id);
    const [capture] = await db().select().from(captures).where(eq(captures.bookingId, booking.id));
    const refund = {
      id: "REFUND-1",
      links: [{ href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${capture.paypalCaptureId}`, rel: "up" }],
    };
    const eventId = await storeEvent("PAYMENT.CAPTURE.REFUNDED", refund, "REFUND-1");
    expect(await processWebhookEvent(h.ctx, eventId)).toBe(true);
    const events = await db().execute<{ flag: string | null }>(
      `select flag from booking_events where booking_id = '${booking.id}'`,
    );
    expect([...events].map((e) => e.flag)).toContain("refunded");
  });
});

describe("liveness", () => {
  it("stuck operations back off and never starve a real recovery", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    // 25 in-flight rows nobody can settle (their booking is gone from the capture states).
    const { booking: other } = await authorizedBooking(h);
    await getDb().update(bookings).set({ sample: false }).where(eq(bookings.id, other.id));
    for (let i = 0; i < 25; i += 1) {
      await db()
        .insert(paymentOperations)
        .values({
          key: `capture:full:${other.id}:retry-${i + 1}`,
          kind: "capture",
          bookingId: other.id,
          paypalRequestId: `t-pay:stuck:${i}`,
          state: "in_flight",
          leaseUntil: new Date(h.now().getTime() - MINUTE),
        });
    }
    h.fake.fault("POST", /\/capture$/, { kind: "lostResponse" }, 3);
    await markJobDone(h.ctx, booking.id);
    h.advance(2 * MINUTE);
    await runTick(h.ctx, db(), h.now());
    h.advance(MINUTE);
    await runTick(h.ctx, db(), h.now());
    expect(["captured", "paid_out"]).toContain((await bookingById(db(), booking.id)).status);
  });
});
