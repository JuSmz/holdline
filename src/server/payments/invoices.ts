import { and, eq, gt, inArray, max } from "drizzle-orm";

import { addonItems, authorizations, captures, customers, invoices } from "@/db/schema";
import { readVar } from "@/server/config/env";
import { type AddonPick, extraWorkLines } from "@/server/domain/pricing";
import { lockBooking, logBookingEvent, setPaymentIssue, transitionBooking } from "@/server/domain/transition";
import type { Executor } from "@/db/types";
import { alreadyDoneOutcome, PayPalApiError } from "@/server/paypal/errors";
import {
  cancelInvoice,
  createInvoice,
  getInvoice,
  isFullyPaid,
  makeInvoiceNumber,
  sendInvoice,
} from "@/server/paypal/invoicing";
import { getOrder } from "@/server/paypal/orders";
import { getAuthorization as getPayPalAuthorization, voidAuthorization } from "@/server/paypal/payments";
import { payPalToCents } from "@/server/money";

import { type PaymentContext, PaymentStateError } from "./context";
import {
  DefiniteOperationError,
  hasOperationInFlight,
  OperationFailedError,
  OperationInProgressError,
  resumableKey,
  runOperation,
} from "./ledger";
import { createPayoutRow, maybePaidOut } from "./payouts";
import { activeAuthorization, assertLive, chainRoot, getBooking, getWorkspace } from "./queries";

export type InvoiceRow = typeof invoices.$inferSelect;

const DAY = 24 * 3_600_000;
const DOUBLE_CLICK_MS = 2 * 60_000;
const BILLABLE = new Set(["completed", "captured", "paid_out"]);

/**
 * Extra work → invoice (SPEC §9.6). Lines come from the workspace's add-ons only; our own invoice
 * number is stored before the call and is the dedup key, since Invoicing ignores PayPal-Request-Id.
 */
export async function billExtraWork(ctx: PaymentContext, bookingId: string, picks: AddonPick[]): Promise<InvoiceRow> {
  const { db, paypal } = ctx;
  const b = await getBooking(db, bookingId);
  assertLive(b);
  if (!BILLABLE.has(b.status)) throw new PaymentStateError("Extra work can be billed after the job is done.");
  if (ctx.now().getTime() > b.slotEnd.getTime() + 14 * DAY) {
    throw new PaymentStateError("Extra work can be billed within 14 days of the visit.");
  }
  const addons = await db.select().from(addonItems).where(eq(addonItems.workspaceId, b.workspaceId));
  const { lines, totalCents } = extraWorkLines(addons, picks);

  // Under the booking lock: a double click with the same items within two minutes gets the same invoice.
  const invoiceNumber = await db.transaction(async (tx) => {
    await lockBooking(tx, bookingId);
    const recent = await tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.bookingId, bookingId),
          eq(invoices.kind, "extra_work"),
          inArray(invoices.status, ["draft", "sent"]),
          gt(invoices.createdAt, new Date(ctx.now().getTime() - DOUBLE_CLICK_MS)),
        ),
      );
    const same = recent.find((r) => JSON.stringify(r.items) === JSON.stringify(lines));
    if (same) return same.invoiceNumber;
    const [{ value: last }] = await tx
      .select({ value: max(invoices.seq) })
      .from(invoices)
      .where(and(eq(invoices.bookingId, bookingId), eq(invoices.kind, "extra_work")));
    const seq = (last ?? 0) + 1;
    const number = makeInvoiceNumber(paypal.instanceId, b.ref, seq, "X");
    await tx
      .insert(invoices)
      .values({ bookingId, invoiceNumber: number, seq, kind: "extra_work", items: lines, totalCents });
    return number;
  });
  const [row] = await db.select().from(invoices).where(eq(invoices.invoiceNumber, invoiceNumber));
  return issueInvoice(
    ctx,
    b.id,
    invoiceNumber,
    `invoice:${bookingId}:${row.seq}`,
    "Extra work after your Holdline visit.",
  );
}

/**
 * Bill via invoice after `capture_failed` (SPEC §9.7): void the live hold FIRST, then invoice the
 * snapshot (or the fee). Disabled while a capture is unresolved; afterwards Retry capture is off for good.
 */
export async function billViaInvoice(ctx: PaymentContext, bookingId: string): Promise<InvoiceRow> {
  const { db, paypal } = ctx;
  // Checks and the claim (the fallback row) under the booking lock: Retry capture takes the same lock
  // and refuses once a fallback row exists; we refuse while any capture is in flight or has taken money.
  const { booking: b, invoiceNumber } = await db.transaction(async (tx) => {
    const locked = await lockBooking(tx, bookingId);
    assertLive(locked);
    const number = makeInvoiceNumber(paypal.instanceId, locked.ref, 1, "F");
    const [existing] = await tx.select().from(invoices).where(eq(invoices.invoiceNumber, number));
    if (existing && existing.status !== "cancelled") return { booking: locked, invoiceNumber: number };
    if (locked.paymentIssue !== "capture_failed") {
      throw new PaymentStateError("Only a failed capture can be billed by invoice.");
    }
    if (await hasOperationInFlight(tx, bookingId, "capture:")) {
      throw new PaymentStateError("A capture is still in progress.", 409, "in_progress");
    }
    const [taken] = await tx
      .select({ id: captures.id })
      .from(captures)
      .where(and(eq(captures.bookingId, bookingId), inArray(captures.status, ["COMPLETED", "PENDING"])));
    if (taken && locked.status !== "captured") {
      throw new PaymentStateError("A capture already took this money.", 409, "already_captured");
    }
    if (existing) throw new PaymentStateError("The fallback invoice was cancelled.", 409, "invoice_cancelled");
    const amountCents = await fallbackAmount(tx, locked);
    const name =
      locked.status === "completed" || locked.status === "captured"
        ? `${locked.serviceName} (${locked.ref})`
        : `No-show fee (${locked.ref})`;
    await tx.insert(invoices).values({
      bookingId,
      invoiceNumber: number,
      seq: 0,
      kind: "fallback",
      items: [{ key: null, name, quantity: 1, unitAmountCents: amountCents }],
      totalCents: amountCents,
    });
    return { booking: locked, invoiceNumber: number };
  });

  // Release any live hold before asking for the money again — and never invoice money PayPal already has.
  const auth = await activeAuthorization(db, b);
  const root = await chainRoot(db, auth);
  const voidKey = await resumableKey(db, `void:${bookingId}:fallback`);
  const voidRequestId = paypal.requestId("void", bookingId, "fallback", ...(voidKey.n ? [`r${voidKey.n}`] : []));
  const { result: released } = await runOperation(db, {
    key: voidKey.key,
    kind: "void",
    bookingId,
    requestId: voidRequestId,
    now: ctx.now,
    run: async () => {
      const current = await getPayPalAuthorization(paypal, auth.paypalAuthorizationId);
      if (current.status === "CAPTURED" || current.status === "PARTIALLY_CAPTURED") {
        const order = auth.paypalOrderId ?? root.paypalOrderId;
        const remote = order ? await getOrder(paypal, order) : null;
        const live = remote?.purchase_units?.[0]?.payments?.captures?.some(
          (c) => c.status === "COMPLETED" || c.status === "PENDING",
        );
        if (live || !remote) throw new DefiniteOperationError("PayPal already captured money on this hold");
      }
      let voided = false;
      if (current.status === "CREATED" || current.status === "PARTIALLY_CAPTURED") {
        try {
          await voidAuthorization(paypal, root.paypalAuthorizationId, { requestId: voidRequestId });
          voided = true;
        } catch (error) {
          const done = alreadyDoneOutcome("void", error) === "voided";
          const expired = error instanceof PayPalApiError && /EXPIRED/.test(error.issue ?? "");
          if (!done && !expired) throw error;
          voided = true;
        }
      }
      return { status: current.status, voided };
    },
  }).catch(async (error: unknown) => {
    if (error instanceof DefiniteOperationError || error instanceof OperationFailedError) {
      // Nothing was sent: drop the draft so Retry capture or a later decision stays possible.
      await db
        .update(invoices)
        .set({ status: "cancelled", updatedAt: ctx.now() })
        .where(and(eq(invoices.invoiceNumber, invoiceNumber), eq(invoices.status, "draft")));
    }
    throw error;
  });
  if (released.voided || released.status === "VOIDED") {
    await db
      .update(authorizations)
      .set({ status: "VOIDED", updatedAt: ctx.now() })
      .where(eq(authorizations.id, root.id));
  }
  const issueKey = await resumableKey(db, `fallback-invoice:${bookingId}`);
  return issueInvoice(ctx, bookingId, invoiceNumber, issueKey.key, "Payment for your Holdline visit.");
}

async function fallbackAmount(db: Executor, b: Awaited<ReturnType<typeof getBooking>>): Promise<number> {
  if (b.status === "completed") return b.priceCents;
  if (b.status === "no_show" || b.status === "cancelled") return b.noShowFeeCents;
  // captured with a PENDING capture that was later declined: bill what that capture asked for.
  const [declined] = await db.select().from(captures).where(eq(captures.bookingId, b.id));
  return declined?.amountCents ?? b.priceCents;
}

/** Create (or recover) and send the invoice under a ledger key; store PayPal's ID and payer link. */
export async function issueInvoice(
  ctx: PaymentContext,
  bookingId: string,
  invoiceNumber: string,
  key: string,
  note: string,
): Promise<InvoiceRow> {
  const { db, paypal } = ctx;
  const [row] = await db.select().from(invoices).where(eq(invoices.invoiceNumber, invoiceNumber));
  if (row.status !== "draft") return row;
  const b = await getBooking(db, bookingId);
  const workspace = await getWorkspace(db, b.workspaceId);
  const [customer] = b.customerId ? await db.select().from(customers).where(eq(customers.id, b.customerId)) : [];
  const invoicerEmail = readVar(process.env, "PAYPAL_BUSINESS_EMAIL");
  if (!invoicerEmail) throw new PaymentStateError("PAYPAL_BUSINESS_EMAIL is not configured.", 503, "not_configured");
  if (!customer?.email) throw new PaymentStateError("The customer has no email address.", 409, "no_email");

  try {
    const { result } = await runOperation(db, {
      key,
      kind: "invoice",
      bookingId,
      requestId: paypal.requestId("invoice-create", invoiceNumber),
      now: ctx.now,
      run: async () => {
        const created = await createInvoice(paypal, {
          invoiceNumber,
          currency: "USD",
          invoicerEmail,
          invoicerBusinessName: workspace.name,
          recipientEmail: customer.email!,
          items: row.items.map((i) => ({ name: i.name, quantity: i.quantity, unitAmountCents: i.unitAmountCents })),
          note,
        });
        const sent = await sendInvoice(paypal, created.id);
        return { paypalInvoiceId: created.id, payerViewUrl: sent.payerViewUrl };
      },
    });
    const [updated] = await db
      .update(invoices)
      .set({
        paypalInvoiceId: result.paypalInvoiceId,
        payerViewUrl: result.payerViewUrl,
        status: "sent",
        updatedAt: ctx.now(),
      })
      .where(and(eq(invoices.id, row.id), eq(invoices.status, "draft")))
      .returning();
    return updated ?? (await getInvoiceRow(ctx, row.id));
  } catch (error) {
    if (error instanceof OperationInProgressError) return getInvoiceRow(ctx, row.id);
    throw error;
  }
}

async function getInvoiceRow(ctx: PaymentContext, id: string): Promise<InvoiceRow> {
  const [row] = await ctx.db.select().from(invoices).where(eq(invoices.id, id));
  return row;
}

/**
 * Re-GET an invoice and apply it (SPEC §9.6.6): paid only on PAID with paid == total. A paid extra-work
 * invoice gets its own payout; a paid fallback invoice recognises the booking's money.
 */
export async function syncInvoice(ctx: PaymentContext, invoiceId: string): Promise<InvoiceRow> {
  const { db, paypal } = ctx;
  const row = await getInvoiceRow(ctx, invoiceId);
  if (!row?.paypalInvoiceId || row.status === "paid" || row.status === "cancelled") return row;
  const remote = await getInvoice(paypal, row.paypalInvoiceId);
  if (remote.status === "CANCELLED") {
    const [updated] = await db
      .update(invoices)
      .set({ status: "cancelled", updatedAt: ctx.now() })
      .where(and(eq(invoices.id, row.id), eq(invoices.status, row.status)))
      .returning();
    return updated ?? row;
  }
  if (!isFullyPaid(remote)) return row;
  const paidCents = Math.min(payPalToCents(remote.payments!.paid_amount!.value), row.totalCents);

  await db.transaction(async (tx) => {
    const b = await lockBooking(tx, row.bookingId);
    const [paid] = await tx
      .update(invoices)
      .set({ status: "paid", paidCents, updatedAt: ctx.now() })
      .where(and(eq(invoices.id, row.id), eq(invoices.status, "sent")))
      .returning();
    if (!paid) return; // another path got here first
    if (row.kind === "fallback" && (b.status === "voided" || b.status === "expired")) {
      // The hold was released (e.g. the fee was waived) but the invoice got paid anyway: no payout, refund by hand.
      await logBookingEvent(tx, {
        bookingId: b.id,
        actor: "webhook",
        flag: "fallback_paid_after_release",
        reason: "refund_needed",
      });
      console.error(`[holdline] ALERT fallback invoice ${row.invoiceNumber} paid after release; refund needed`);
      return;
    }
    if (row.kind === "fallback") {
      if (b.status === "completed" || b.status === "no_show" || b.status === "cancelled") {
        await transitionBooking(tx, {
          bookingId: b.id,
          from: b.status,
          to: "captured",
          actor: "webhook",
          reason: "fallback_invoice_paid",
          flag: null,
        });
      } else if (b.status === "captured" && b.paymentIssue === "capture_failed") {
        await setPaymentIssue(tx, { bookingId: b.id, flag: null, actor: "webhook", reason: "fallback_invoice_paid" });
      }
    }
    await createPayoutRow(tx, {
      instanceId: paypal.instanceId,
      workspaceId: b.workspaceId,
      bookingId: b.id,
      technicianId: b.technicianId,
      source: "invoice",
      sourceId: row.id,
      recognisedCents: paidCents,
    });
  });
  await maybePaidOut(ctx, row.bookingId);
  return getInvoiceRow(ctx, row.id);
}

/** Cancels a sent invoice that is no longer wanted (owner action). */
export async function cancelSentInvoice(ctx: PaymentContext, invoiceId: string): Promise<InvoiceRow> {
  const row = await getInvoiceRow(ctx, invoiceId);
  if (!row || row.status !== "sent" || !row.paypalInvoiceId)
    throw new PaymentStateError("Only a sent invoice can be cancelled.");
  await cancelInvoice(ctx.paypal, row.paypalInvoiceId);
  return syncInvoice(ctx, invoiceId);
}
