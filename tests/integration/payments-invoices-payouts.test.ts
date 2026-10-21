import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { addonItems, captures, payouts } from "@/db/schema";
import { markJobDone } from "@/server/payments/capture";
import { billExtraWork, syncInvoice } from "@/server/payments/invoices";
import { runTick } from "@/server/payments/jobs";
import { createPayoutRow, retryPayout, sendPayout, syncPayout } from "@/server/payments/payouts";
import { processWebhookEvent } from "@/server/payments/webhook-processor";

import { bookingById } from "../support/factory";
import { authorizedBooking, INSTANCE, paymentHarness, resetPayments, storeEvent } from "../support/payments";

beforeEach(async () => {
  await resetPayments();
  vi.stubEnv("PAYPAL_BUSINESS_EMAIL", "merchant@business.example.com");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

const db = () => getDb();

async function paidOutBooking(h: ReturnType<typeof paymentHarness>) {
  const a = await authorizedBooking(h);
  await markJobDone(h.ctx, a.booking.id);
  await runTick(h.ctx, db(), h.now());
  expect((await bookingById(db(), a.booking.id)).status).toBe("paid_out");
  return a;
}

async function addonId(workspaceId: string, key: string) {
  const rows = await db().select().from(addonItems).where(eq(addonItems.workspaceId, workspaceId));
  return rows.find((r) => r.key === key)!.id;
}

describe("SPEC §24 payment matrix: invoices and payouts", () => {
  it("#22 extra work after paid_out → invoice → PAID (duplicated webhook) → one second payout", async () => {
    const h = paymentHarness();
    const { ws, booking } = await paidOutBooking(h);
    const invoice = await billExtraWork(h.ctx, booking.id, [
      { addonId: await addonId(ws.id, "shutoff-valve"), quantity: 2 },
      { addonId: await addonId(ws.id, "extra-labor"), quantity: 1 },
    ]);
    expect(invoice).toMatchObject({ kind: "extra_work", status: "sent", totalCents: 9_500, seq: 1 });
    expect(invoice.invoiceNumber).toBe(`${INSTANCE}-${booking.ref.replace("-", "")}-X1`);

    h.fake.payInvoice(invoice.paypalInvoiceId!);
    const e1 = await storeEvent("INVOICING.INVOICE.PAID", { id: invoice.paypalInvoiceId }, invoice.paypalInvoiceId!);
    const e2 = await storeEvent("INVOICING.INVOICE.PAID", { id: invoice.paypalInvoiceId }, invoice.paypalInvoiceId!);
    await Promise.all([processWebhookEvent(h.ctx, e1), processWebhookEvent(h.ctx, e2)]);
    const rows = await db().select().from(payouts).where(eq(payouts.bookingId, booking.id));
    expect(rows.map((r) => [r.source, r.amountCents]).sort()).toEqual([
      ["capture", 8_940],
      ["invoice", 5_700],
    ]);
    await runTick(h.ctx, db(), h.now());
    expect(
      (await db().select().from(payouts).where(eq(payouts.bookingId, booking.id))).every(
        (r) => r.status === "succeeded",
      ),
    ).toBe(true);
    // The booking's main lifecycle is untouched by the extra-work invoice.
    expect((await bookingById(db(), booking.id)).status).toBe("paid_out");
  });

  it("#22 PARTIALLY_PAID never pays out", async () => {
    const h = paymentHarness();
    const { ws, booking } = await paidOutBooking(h);
    const invoice = await billExtraWork(h.ctx, booking.id, [{ addonId: await addonId(ws.id, "p-trap"), quantity: 1 }]);
    h.fake.payInvoice(invoice.paypalInvoiceId!, 1_000);
    expect((await syncInvoice(h.ctx, invoice.id)).status).toBe("sent");
    expect(await db().select().from(payouts).where(eq(payouts.bookingId, booking.id))).toHaveLength(1);
  });

  it("#23 a lost invoice-create response is recovered by search, never created twice", async () => {
    const h = paymentHarness();
    const { ws, booking } = await paidOutBooking(h);
    h.fake.fault("POST", /^\/v2\/invoicing\/invoices$/, { kind: "lostResponse" }, 1);
    const invoice = await billExtraWork(h.ctx, booking.id, [
      { addonId: await addonId(ws.id, "gfci-outlet"), quantity: 1 },
    ]);
    expect(invoice.status).toBe("sent");
    expect(h.fake.invoices.size).toBe(1);
    expect(h.fake.calls("POST", /^\/v2\/invoicing\/invoices$/)).toHaveLength(1);
    expect(h.fake.calls("POST", /search-invoices/)).toHaveLength(1);
  });

  it("#5 a double click on Bill extra work sends one invoice", async () => {
    const h = paymentHarness();
    const { ws, booking } = await paidOutBooking(h);
    const picks = [{ addonId: await addonId(ws.id, "materials-kit"), quantity: 3 }];
    const [a, b] = await Promise.all([
      billExtraWork(h.ctx, booking.id, picks),
      billExtraWork(h.ctx, booking.id, picks),
    ]);
    expect(a.id).toBe(b.id);
    expect(h.fake.invoices.size).toBe(1);
  });

  it("#24 concurrent payout creation (webhook + job + sync) → one payout", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    await markJobDone(h.ctx, booking.id);
    const [capture] = await db().select().from(captures).where(eq(captures.bookingId, booking.id));
    const b = await bookingById(db(), booking.id);
    const create = () =>
      db().transaction((tx) =>
        createPayoutRow(tx, {
          instanceId: INSTANCE,
          workspaceId: b.workspaceId,
          bookingId: b.id,
          technicianId: b.technicianId,
          source: "capture",
          sourceId: capture.id,
          recognisedCents: capture.amountCents,
        }),
      );
    await Promise.all([create(), create(), create()]);
    const [row, ...rest] = await db().select().from(payouts).where(eq(payouts.bookingId, booking.id));
    expect(rest).toHaveLength(0);
    await Promise.all([sendPayout(h.ctx, row.id), sendPayout(h.ctx, row.id), runTick(h.ctx, db(), h.now())]);
    expect(h.fake.payoutBatches.size).toBe(1);
  });

  it("#25 payout FAILED → retry creates attempt 2 and pays", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.next.payoutItemStatus.push("FAILED");
    await markJobDone(h.ctx, booking.id);
    await runTick(h.ctx, db(), h.now());
    const [first] = await db().select().from(payouts).where(eq(payouts.bookingId, booking.id));
    expect(first.status).toBe("failed");
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "captured", paymentIssue: "payout_failed" });

    const second = await retryPayout(h.ctx, first.id);
    expect(second).toMatchObject({ attemptNo: 2, status: "succeeded" });
    expect(second.senderBatchId).not.toBe(first.senderBatchId);
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "paid_out", paymentIssue: null });
  });

  it("#25 UNCLAIMED → cancel first, then a new attempt", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    h.fake.next.payoutItemStatus.push("UNCLAIMED");
    await markJobDone(h.ctx, booking.id);
    await runTick(h.ctx, db(), h.now());
    const [first] = await db().select().from(payouts).where(eq(payouts.bookingId, booking.id));
    expect(first.status).toBe("unclaimed");
    const second = await retryPayout(h.ctx, first.id);
    expect(h.fake.calls("POST", /payouts-item\/.+\/cancel$/)).toHaveLength(1);
    expect(second).toMatchObject({ attemptNo: 2, status: "succeeded" });
    expect((await syncPayout(h.ctx, first.id)).status).toBe("failed"); // RETURNED
    expect((await bookingById(db(), booking.id)).status).toBe("paid_out");
  });

  it("waits for a technician payout email before sending", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    await db().execute(`update technicians set payout_email = null where id = '${booking.technicianId}'`);
    await markJobDone(h.ctx, booking.id);
    await runTick(h.ctx, db(), h.now());
    const [row] = await db().select().from(payouts).where(eq(payouts.bookingId, booking.id));
    expect(row.status).toBe("pending");
    expect(h.fake.payoutBatches.size).toBe(0);
  });
});
