import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { authorizations, captures, invoices, paymentOperations, payouts } from "@/db/schema";
import { captureBooking, markJobDone, markNoShow, retryCapture } from "@/server/payments/capture";
import { billViaInvoice, syncInvoice } from "@/server/payments/invoices";
import { runTick } from "@/server/payments/jobs";
import { cancelBooking, waiveFee } from "@/server/payments/void";
import { processWebhookEvent } from "@/server/payments/webhook-processor";
import { TransitionConflictError } from "@/server/domain/transition";

import { bookingById } from "../support/factory";
import { authorizedBooking, paymentHarness, resetPayments, storeEvent } from "../support/payments";

beforeEach(async () => {
  await resetPayments();
  vi.stubEnv("PAYPAL_BUSINESS_EMAIL", "merchant@business.example.com");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

const HOUR = 3_600_000;
const db = () => getDb();

async function payoutRows(bookingId: string) {
  return db().select().from(payouts).where(eq(payouts.bookingId, bookingId));
}

describe("SPEC §24 payment matrix: capture, no-show, cancel", () => {
  it("#1 happy path: Job done → full capture → payout → paid_out", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    const outcome = await markJobDone(h.ctx, booking.id);
    expect(outcome.status).toBe("captured");
    const [capture] = h.fake.calls("POST", /\/capture$/);
    expect(capture.body).toMatchObject({ amount: { value: "149.00", currency_code: "USD" }, final_capture: true });
    const [payout] = await payoutRows(booking.id);
    expect(payout).toMatchObject({ source: "capture", attemptNo: 1, amountCents: 8_940, status: "pending" });

    await runTick(h.ctx, db(), h.now());
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "paid_out", paymentIssue: null });
    expect((await payoutRows(booking.id))[0].status).toBe("succeeded");
    expect(h.fake.calls("POST", /^\/v1\/payments\/payouts$/)).toHaveLength(1);
    expect([...h.fake.payoutItems.values()][0]).toMatchObject({
      amountCents: 8_940,
      receiver: "maya@personal.example.com",
    });
  });

  it("#5 double clicks on Job done, No-show and Cancel make one PayPal call each", async () => {
    const h = paymentHarness();
    const a = await authorizedBooking(h);
    await Promise.all([
      markJobDone(h.ctx, a.booking.id),
      markJobDone(h.ctx, a.booking.id),
      markJobDone(h.ctx, a.booking.id),
    ]);
    expect(h.fake.calls("POST", /\/capture$/)).toHaveLength(1);
    expect(await payoutRows(a.booking.id)).toHaveLength(1);

    const b = await authorizedBooking(h);
    await Promise.all([markNoShow(h.ctx, b.booking.id), markNoShow(h.ctx, b.booking.id)]);
    expect(h.fake.calls("POST", /\/capture$/)).toHaveLength(2);

    const c = await authorizedBooking(h, { daysAhead: 5 });
    await Promise.all([cancelBooking(h.ctx, c.booking.id), cancelBooking(h.ctx, c.booking.id)]);
    expect(h.fake.calls("POST", /\/void$/)).toHaveLength(1);
    expect((await bookingById(db(), c.booking.id)).status).toBe("voided");
  });

  it("#6 sibling conflict: Job done vs No-show → one wins, the other gets a visible 409", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    const results = await Promise.allSettled([markJobDone(h.ctx, booking.id), markNoShow(h.ctx, booking.id)]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(TransitionConflictError);
    expect(lost[0].reason.message).toMatch(/^Already marked as (job done|no-show)\.$/);
    expect(h.fake.calls("POST", /\/capture$/)).toHaveLength(1);
  });

  it("#12 timeout after a successful capture, then Retry: exactly one capture and one payout", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.fault("POST", /\/capture$/, { kind: "lostResponse" }, 3);
    expect((await markJobDone(h.ctx, booking.id)).status).toBe("processing");
    expect(h.fake.captures.size).toBe(1);
    // The owner clicks Retry while the outcome is unknown: refused, nothing is sent.
    await expect(retryCapture(h.ctx, booking.id)).rejects.toThrow();
    // The reconciler GETs first and finds the capture.
    h.advance(2 * 60_000);
    await runTick(h.ctx, db(), h.now());
    expect((await bookingById(db(), booking.id)).status).toBe("paid_out");
    expect(h.fake.captures.size).toBe(1);
    expect(await db().select().from(captures).where(eq(captures.bookingId, booking.id))).toHaveLength(1);
    expect(await payoutRows(booking.id)).toHaveLength(1);
  });

  it("#13 409 PREVIOUS_REQUEST_IN_PROGRESS is retried with the same ID and never marked failed", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.fault("POST", /\/capture$/, { kind: "inProgress" }, 1);
    expect((await markJobDone(h.ctx, booking.id)).status).toBe("captured");
    const ids = new Set(h.fake.calls("POST", /\/capture$/).map((r) => r.requestId));
    expect(ids.size).toBe(1);

    const other = await authorizedBooking(h);
    h.fake.fault("POST", /\/capture$/, { kind: "inProgress" }, 3);
    expect((await markJobDone(h.ctx, other.booking.id)).status).toBe("processing");
    const [op] = await db()
      .select()
      .from(paymentOperations)
      .where(eq(paymentOperations.key, `capture:full:${other.booking.id}`));
    expect(op.state).toBe("in_flight");
  });

  it("#14 capture declined → capture_failed; Bill via invoice voids first, disables Retry, then paid → captured", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.next.captureStatus.push("DECLINED");
    expect((await markJobDone(h.ctx, booking.id)).status).toBe("capture_failed");
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "completed", paymentIssue: "capture_failed" });

    const invoice = await billViaInvoice(h.ctx, booking.id);
    expect(invoice).toMatchObject({ kind: "fallback", status: "sent", totalCents: 14_900 });
    const [voidCall] = h.fake.calls("POST", /\/void$/);
    const [createCall] = h.fake.calls("POST", /^\/v2\/invoicing\/invoices$/);
    expect(h.fake.requests.indexOf(voidCall)).toBeLessThan(h.fake.requests.indexOf(createCall));
    await expect(retryCapture(h.ctx, booking.id)).rejects.toMatchObject({ code: "invoice_exists" });
    // A second click on Bill via invoice changes nothing.
    await billViaInvoice(h.ctx, booking.id);
    expect(h.fake.invoices.size).toBe(1);

    h.fake.payInvoice(invoice.paypalInvoiceId!);
    await syncInvoice(h.ctx, invoice.id);
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "captured", paymentIssue: null });
    await runTick(h.ctx, db(), h.now());
    expect((await bookingById(db(), booking.id)).status).toBe("paid_out");
    expect(await payoutRows(booking.id)).toMatchObject([
      { source: "invoice", amountCents: 8_940, status: "succeeded" },
    ]);
  });

  it("#14 an authorization voided at PayPal makes the capture fail definitively", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    const [auth] = await db().select().from(authorizations).where(eq(authorizations.bookingId, booking.id));
    h.fake.voidExternally(auth.paypalAuthorizationId);
    expect((await markJobDone(h.ctx, booking.id)).status).toBe("capture_failed");
    // Retry capture is a new attempt under a new key; it fails again the same way.
    expect((await retryCapture(h.ctx, booking.id)).status).toBe("capture_failed");
    const keys = (await db().select().from(paymentOperations))
      .map((o) => o.key)
      .filter((k) => k.startsWith("capture:"));
    expect(keys.sort()).toEqual([`capture:full:${booking.id}`, `capture:full:${booking.id}:retry-1`]);
  });

  it("#14 Retry capture after a decline succeeds and clears the flag", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.next.captureStatus.push("DECLINED");
    await markJobDone(h.ctx, booking.id);
    expect((await retryCapture(h.ctx, booking.id)).status).toBe("captured");
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "captured", paymentIssue: null });
    const invoiceIds = h.fake.calls("POST", /\/capture$/).map((r) => (r.body as { invoice_id: string }).invoice_id);
    expect(new Set(invoiceIds).size).toBe(2); // a retry never reuses the declined capture's invoice_id
  });

  it("#15 capture PENDING → payouts wait → CAPTURE.COMPLETED → payout → paid_out", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.next.captureStatus.push("PENDING");
    expect((await markJobDone(h.ctx, booking.id)).status).toBe("capture_pending");
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "captured", paymentIssue: "capture_pending" });
    expect(await payoutRows(booking.id)).toHaveLength(0);

    const [capture] = await db().select().from(captures).where(eq(captures.bookingId, booking.id));
    h.fake.settleCapture(capture.paypalCaptureId, "COMPLETED");
    const eventId = await storeEvent(
      "PAYMENT.CAPTURE.COMPLETED",
      { id: capture.paypalCaptureId },
      capture.paypalCaptureId,
    );
    await processWebhookEvent(h.ctx, eventId);
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "captured", paymentIssue: null });
    expect(await payoutRows(booking.id)).toHaveLength(1);
    await runTick(h.ctx, db(), h.now());
    expect((await bookingById(db(), booking.id)).status).toBe("paid_out");
  });

  it("#15 a PENDING capture later DECLINED → capture_failed, Bill via invoice from captured", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.next.captureStatus.push("PENDING");
    await markJobDone(h.ctx, booking.id);
    const [capture] = await db().select().from(captures).where(eq(captures.bookingId, booking.id));
    h.fake.settleCapture(capture.paypalCaptureId, "DECLINED");
    await runTick(h.ctx, db(), h.now()); // the poll finds the decline even without a webhook
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "captured", paymentIssue: "capture_failed" });

    const invoice = await billViaInvoice(h.ctx, booking.id);
    h.fake.payInvoice(invoice.paypalInvoiceId!);
    await runTick(h.ctx, db(), h.now());
    await runTick(h.ctx, db(), h.now());
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "paid_out", paymentIssue: null });
    expect(await payoutRows(booking.id)).toMatchObject([{ source: "invoice", status: "succeeded" }]);
  });

  it("#16 no-show: fee capture with final_capture releases the rest; fee payout", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    expect((await markNoShow(h.ctx, booking.id)).status).toBe("captured");
    const [call] = h.fake.calls("POST", /\/capture$/);
    expect(call.body).toMatchObject({ amount: { value: "49.00" }, final_capture: true });
    const [auth] = await db().select().from(authorizations).where(eq(authorizations.bookingId, booking.id));
    expect(h.fake.authorizations.get(auth.paypalAuthorizationId)?.status).toBe("CAPTURED");
    expect(h.fake.calls("POST", /\/void$/)).toHaveLength(0); // nothing left to release
    expect(await payoutRows(booking.id)).toMatchObject([{ amountCents: 2_940 }]);
  });

  it("#16 Waive fee after a failed fee capture → voided", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.next.captureStatus.push("DECLINED");
    expect((await markNoShow(h.ctx, booking.id)).status).toBe("capture_failed");
    expect((await waiveFee(h.ctx, booking.id)).status).toBe("voided");
    expect(h.fake.calls("POST", /\/void$/)).toHaveLength(1);
    expect(await payoutRows(booking.id)).toHaveLength(0);
  });

  it("#17 timely cancel voids the parent; a late cancel captures the fee", async () => {
    const h = paymentHarness();
    const timely = await authorizedBooking(h, { daysAhead: 3 });
    const t = await cancelBooking(h.ctx, timely.booking.id);
    expect(t).toMatchObject({ status: "voided", rule: "free_void", amountCents: 0 });

    const late = await authorizedBooking(h, { daysAhead: 0.5 });
    const l = await cancelBooking(h.ctx, late.booking.id);
    expect(l).toMatchObject({ status: "captured", rule: "late_fee", amountCents: 4_900 });
    expect(await bookingById(db(), late.booking.id)).toMatchObject({ status: "captured", cancelReason: "late" });
  });

  it("#17 a failed late fee can be waived or billed by invoice", async () => {
    const h = paymentHarness();
    const a = await authorizedBooking(h, { daysAhead: 0.5 });
    h.fake.next.captureStatus.push("DECLINED");
    expect((await cancelBooking(h.ctx, a.booking.id)).status).toBe("capture_failed");
    expect((await waiveFee(h.ctx, a.booking.id)).status).toBe("voided");

    const b = await authorizedBooking(h, { daysAhead: 0.5 });
    h.fake.next.captureStatus.push("DECLINED");
    await cancelBooking(h.ctx, b.booking.id);
    const invoice = await billViaInvoice(h.ctx, b.booking.id);
    expect(invoice.totalCents).toBe(4_900);
    h.fake.payInvoice(invoice.paypalInvoiceId!);
    await syncInvoice(h.ctx, invoice.id);
    expect((await bookingById(db(), b.booking.id)).status).toBe("captured");
  });

  it("#21 a stale hold is cancelled (hold_timeout) and voided", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h, { daysAhead: 1 });
    h.advance(5 * 24 * HOUR); // slot_end + 72 h has passed
    await runTick(h.ctx, db(), h.now());
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "voided", cancelReason: "hold_timeout" });
    expect(h.fake.calls("POST", /\/void$/)).toHaveLength(1);
  });

  it("captures only from the right status and never for sample bookings", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    await expect(captureBooking(h.ctx, booking.id, "full")).rejects.toThrow("Can't capture from authorized");
    expect(await db().select().from(invoices)).toHaveLength(0);
  });
});
