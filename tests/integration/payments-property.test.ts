import { eq } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { addonItems, invoices, paypalOrders, payouts } from "@/db/schema";
import { STATUS_RANK } from "@/server/domain/booking-state";
import { InvoiceInputError, payoutCents } from "@/server/domain/pricing";
import { TransitionConflictError } from "@/server/domain/transition";
import { authorizeBooking, createOrderForBooking } from "@/server/payments/authorize";
import { markJobDone, markNoShow, retryCapture } from "@/server/payments/capture";
import { PaymentStateError } from "@/server/payments/context";
import { billExtraWork, billViaInvoice, syncInvoice } from "@/server/payments/invoices";
import { runTick } from "@/server/payments/jobs";
import { OperationFailedError, OperationInProgressError } from "@/server/payments/ledger";
import { retryPayout } from "@/server/payments/payouts";
import { cancelBooking, waiveFee } from "@/server/payments/void";
import { processWebhookEvent } from "@/server/payments/webhook-processor";

import { bookingById } from "../support/factory";
import { type Harness, paymentHarness, pendingBooking, resetPayments, storeEvent } from "../support/payments";

beforeAll(() => {
  vi.stubEnv("PAYPAL_BUSINESS_EMAIL", "merchant@business.example.com");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

const HOUR = 3_600_000;
const RUNS = Number(process.env.FC_RUNS ?? 30);
const db = () => getDb();

const ACTIONS = [
  "pay",
  "pay",
  "approvedWebhook",
  "jobDone",
  "noShow",
  "cancel",
  "waive",
  "retryCapture",
  "billViaInvoice",
  "extraWork",
  "payInvoices",
  "retryPayouts",
  "tick",
  "advanceHour",
  "advanceDay",
  "faultCapture",
  "faultAuthorize",
  "declineNextCapture",
  "pendingNextCapture",
  "failNextPayout",
  "raceRetryVsInvoice",
  "raceJobDoneVsNoShow",
  "raceCancelVsTick",
] as const;
type Action = (typeof ACTIONS)[number];

/** Business refusals the owner or the buyer can legitimately run into. Anything else fails the property. */
const expected = (e: unknown) =>
  e instanceof PaymentStateError ||
  e instanceof TransitionConflictError ||
  e instanceof OperationFailedError ||
  e instanceof OperationInProgressError ||
  e instanceof InvoiceInputError;

async function act(h: Harness, bookingId: string, workspaceId: string, action: Action) {
  switch (action) {
    case "pay": {
      const { orderId } = await createOrderForBooking(h.ctx, bookingId);
      h.fake.approve(orderId);
      await authorizeBooking(h.ctx, bookingId, orderId);
      return;
    }
    case "approvedWebhook": {
      const [order] = await db().select().from(paypalOrders).where(eq(paypalOrders.bookingId, bookingId));
      if (!order) return;
      h.fake.approve(order.paypalOrderId);
      const id = await storeEvent("CHECKOUT.ORDER.APPROVED", { id: order.paypalOrderId }, order.paypalOrderId);
      await Promise.all([processWebhookEvent(h.ctx, id), processWebhookEvent(h.ctx, id)]);
      return;
    }
    case "jobDone":
      return void (await markJobDone(h.ctx, bookingId));
    case "noShow":
      return void (await markNoShow(h.ctx, bookingId));
    case "cancel":
      return void (await cancelBooking(h.ctx, bookingId));
    case "waive":
      return void (await waiveFee(h.ctx, bookingId));
    case "retryCapture":
      return void (await retryCapture(h.ctx, bookingId));
    case "billViaInvoice":
      return void (await billViaInvoice(h.ctx, bookingId));
    case "extraWork": {
      const [addon] = await db().select().from(addonItems).where(eq(addonItems.workspaceId, workspaceId));
      return void (await billExtraWork(h.ctx, bookingId, [{ addonId: addon.id, quantity: 1 }]));
    }
    case "payInvoices": {
      const rows = await db().select().from(invoices).where(eq(invoices.bookingId, bookingId));
      for (const row of rows) {
        if (row.paypalInvoiceId && h.fake.invoices.get(row.paypalInvoiceId)?.status === "SENT") {
          h.fake.payInvoice(row.paypalInvoiceId);
          await syncInvoice(h.ctx, row.id);
        }
      }
      return;
    }
    case "retryPayouts": {
      const rows = await db().select().from(payouts).where(eq(payouts.bookingId, bookingId));
      for (const row of rows)
        if (row.status === "failed" || row.status === "unclaimed") await retryPayout(h.ctx, row.id);
      return;
    }
    case "tick":
      return void (await runTick(h.ctx, db(), h.now()));
    case "advanceHour":
      return h.advance(HOUR);
    case "advanceDay":
      return h.advance(24 * HOUR);
    case "faultCapture":
      return h.fake.fault("POST", /\/capture$/, { kind: "lostResponse" }, 3);
    case "faultAuthorize":
      return h.fake.fault("POST", /\/authorize$/, { kind: "http", status: 500 }, 3);
    case "declineNextCapture":
      return void h.fake.next.captureStatus.push("DECLINED");
    case "pendingNextCapture":
      return void h.fake.next.captureStatus.push("PENDING");
    case "failNextPayout":
      return void h.fake.next.payoutItemStatus.push("FAILED");
    case "raceRetryVsInvoice":
      return race([retryCapture(h.ctx, bookingId), billViaInvoice(h.ctx, bookingId)]);
    case "raceJobDoneVsNoShow":
      return race([markJobDone(h.ctx, bookingId), markNoShow(h.ctx, bookingId)]);
    case "raceCancelVsTick":
      return race([cancelBooking(h.ctx, bookingId), runTick(h.ctx, db(), h.now())]);
  }
}

/** Concurrent owner actions: each may lose with an expected refusal; anything else fails the property. */
async function race(actions: Promise<unknown>[]) {
  const results = await Promise.allSettled(actions);
  for (const r of results) if (r.status === "rejected" && !expected(r.reason)) throw r.reason;
}

/** SPEC §8.4.7, checked against PayPal's (the fake's) ground truth after every step. */
async function assertMoneyInvariant(h: Harness, bookingId: string) {
  const b = await bookingById(db(), bookingId);
  const auths = [...h.fake.authorizations.values()].filter((a) => a.customId === bookingId);
  const roots = auths.filter((a) => !a.parentId);
  const live = roots.filter((root) => {
    const chain = [root, ...auths.filter((a) => a.parentId === root.id)];
    return chain.some((a) => a.status === "CREATED" || a.status === "PARTIALLY_CAPTURED" || a.status === "PENDING");
  });
  // At most one live hold after any completed operation.
  expect(live.length).toBeLessThanOrEqual(1);
  // Total captured ≤ the authorized snapshot amount.
  const authIds = new Set(auths.map((a) => a.id));
  const capturedCents = [...h.fake.captures.values()]
    .filter((c) => authIds.has(c.authorizationId) && (c.status === "COMPLETED" || c.status === "PENDING"))
    .reduce((sum, c) => sum + c.amountCents, 0);
  // Recognised money (captures plus a paid fallback invoice) never exceeds the snapshot: no double charge.
  const bookingInvoices = await db().select().from(invoices).where(eq(invoices.bookingId, bookingId));
  const fallbackPaidCents = bookingInvoices
    .filter((i) => i.kind === "fallback" && i.paypalInvoiceId)
    .reduce((sum, i) => {
      const remote = h.fake.invoices.get(i.paypalInvoiceId!);
      return sum + (remote && (remote.status === "PAID" || remote.status === "PARTIALLY_PAID") ? remote.paidCents : 0);
    }, 0);
  expect(capturedCents + fallbackPaidCents).toBeLessThanOrEqual(b.priceCents);
  // A completed capture and a payable fallback invoice never coexist.
  const completed = [...h.fake.captures.values()].some(
    (c) => authIds.has(c.authorizationId) && c.status === "COMPLETED",
  );
  const payableFallback = bookingInvoices.some(
    (i) =>
      i.kind === "fallback" &&
      i.paypalInvoiceId &&
      ["SENT", "PAID"].includes(h.fake.invoices.get(i.paypalInvoiceId)?.status ?? ""),
  );
  expect(completed && payableFallback).toBe(false);
  // No hold survives a terminal release.
  if (b.status === "voided" || b.status === "expired") expect(live).toHaveLength(0);
  // Payouts: at most one succeeded per source and technician; amounts are the floored share.
  const rows = await db().select().from(payouts).where(eq(payouts.bookingId, bookingId));
  const succeeded = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== "succeeded") continue;
    const k = `${r.source}:${r.sourceId}:${r.technicianId}`;
    succeeded.set(k, (succeeded.get(k) ?? 0) + 1);
  }
  for (const n of succeeded.values()) expect(n).toBe(1);
  const items = [...h.fake.payoutItems.values()];
  for (const r of rows.filter((x) => x.paypalBatchId)) {
    expect(items.filter((i) => i.senderItemId === r.senderItemId)).toHaveLength(1);
  }
  // Paid invoices ↔ invoice payouts.
  const paid = (await db().select().from(invoices).where(eq(invoices.bookingId, bookingId))).filter(
    (i) => i.status === "paid",
  );
  for (const inv of paid) {
    const first = rows.find((r) => r.source === "invoice" && r.sourceId === inv.id && r.attemptNo === 1);
    expect(first?.amountCents).toBe(payoutCents(inv.paidCents, 6_000));
  }
  return b;
}

describe("money and rank invariants under random owner clicks, webhooks, ticks and faults (SPEC §8.5)", () => {
  it(
    "never lowers the rank and never breaks §8.4.7",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom(...ACTIONS), { minLength: 4, maxLength: 14 }),
          fc.constantFrom(0.5, 2, 5, 10),
          async (actions, daysAhead) => {
            await resetPayments();
            const h = paymentHarness();
            const { ws, booking } = await pendingBooking(h, { daysAhead });
            let rank = 0;
            for (const action of actions) {
              try {
                await act(h, booking.id, ws.id, action);
              } catch (error) {
                if (!expected(error)) throw error;
              }
              const b = await assertMoneyInvariant(h, booking.id);
              expect(STATUS_RANK[b.status]).toBeGreaterThanOrEqual(rank);
              rank = STATUS_RANK[b.status];
            }
          },
        ),
        // FC_RUNS=300 for a deeper local search; CI keeps the default.
        { numRuns: RUNS },
      );
    },
    RUNS * 6_000,
  );
});
