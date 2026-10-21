import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";

import {
  authorizations,
  bookings,
  calls,
  captures,
  customers,
  emailIdentities,
  invoices,
  outboxEmails,
  paymentOperations,
  paypalOrders,
  vapiEvents,
  webhookEvents,
  workspaces,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { dbErrorCode } from "@/server/db-error";
import { policyOf } from "@/server/domain/policy";
import { transitionBooking } from "@/server/domain/transition";
import { payPalToCents } from "@/server/money";
import { alreadyDoneOutcome, PayPalApiError } from "@/server/paypal/errors";
import { getOrder } from "@/server/paypal/orders";
import { getCapture, voidAuthorization } from "@/server/paypal/payments";
import { getPayoutItem } from "@/server/paypal/payouts";

import { authorizeBooking, createOrderForBooking, voidOrphan } from "./authorize";
import { applyCapture, captureBooking, type CaptureKind } from "./capture";
import { processCaptureStatus } from "./capture-status";
import type { PaymentContext } from "./context";
import { billViaInvoice, issueInvoice, syncInvoice } from "./invoices";
import { DefiniteOperationError, hasOperationInFlight, type OperationRow, runOperation } from "./ledger";
import { pendingPayoutIds, processingPayoutIds, sendPayout, syncPayout } from "./payouts";
import { getAuthorization, getBooking } from "./queries";
import { reauthorizeBooking } from "./reauthorize";
import { releaseStaleHold, voidHold } from "./void";
import { processWebhookEvent, unprocessedEventIds } from "./webhook-processor";

const BATCH = 20;
const DAY = 24 * 3_600_000;
/** Approved orders older than this are not chased any more by the reconciler. */
const ORDER_CHASE_MS = 3 * 3_600_000;
const RETENTION_DAYS = 14;

export type TickReport = Record<string, number>;

/**
 * One tick of the job runner (SPEC §12), in the documented order. Every job is idempotent and bounded;
 * one item's failure is logged (codes only) and never stops the rest.
 */
export async function runTick(ctx: PaymentContext | null, db: Db, now: Date = new Date()): Promise<TickReport> {
  const report: TickReport = {};
  const count = (k: string, n = 1) => (report[k] = (report[k] ?? 0) + n);
  const each = async <T>(label: string, items: T[], fn: (item: T) => Promise<unknown>) => {
    for (const item of items) {
      try {
        await fn(item);
        count(label);
      } catch (error) {
        count(`${label}_errors`);
        console.error(`[holdline] job ${label} failed: ${dbErrorCode(error)}`);
      }
    }
  };

  if (ctx) {
    // 1. Reconcile
    await each("reconcile_ops", await expiredOperations(db, now), (op) => resumeOperation(ctx, op));
    await each("reconcile_webhooks", await unprocessedEventIds(ctx, BATCH), (id) => processWebhookEvent(ctx, id));
    await each("reconcile_approved_orders", await openOrders(db, now), (o) =>
      chaseOrder(ctx, o.bookingId, o.paypalOrderId),
    );
    await each("reconcile_orphans", await orphanCandidates(db), (a) => voidOrphan(ctx, a, "sweep"));
    await each("reconcile_invoices", await sentInvoiceIds(db), (id) => syncInvoice(ctx, id));
    await each("reconcile_captures", await pendingCaptureIds(db), (id) => refreshCapture(ctx, id));
    await each("reconcile_payouts", await processingPayoutIds(db, BATCH), (id) => syncPayout(ctx, id));
    // 2. Outbox: email delivery arrives in stage 8.
    // 3. Expire unpaid
    await each("expire_unpaid", await unpaidExpired(db, now), (b) => expireUnpaid(ctx, b.id));
    // 4. Reauthorize
    await each("reauthorize", await dueReauthorizations(db, now), (bookingId) => reauthorizeBooking(ctx, bookingId));
    // 5. Release stale holds
    await each("stale_holds", await staleHolds(db, now), (bookingId) => releaseStaleHold(ctx, bookingId));
    // 6. Payouts
    await each("payouts_sent", await pendingPayoutIds(db, BATCH), (id) => sendPayout(ctx, id));
    // 7. Summaries: stage 8.
  }
  // 8. Retention (no PayPal needed)
  await each("retention", [now], (at) => purgeExpiredPii(db, at));
  return report;
}

// ── 1. Reconcile ─────────────────────────────────────────────────────────────────────────────────

async function expiredOperations(db: Db, now: Date): Promise<OperationRow[]> {
  return db
    .select()
    .from(paymentOperations)
    .where(and(eq(paymentOperations.state, "in_flight"), lt(paymentOperations.leaseUntil, now)))
    .limit(BATCH);
}

/** Re-drives an in-flight ledger row whose lease expired: GET first, then the same request ID (§10.3.4). */
export async function resumeOperation(ctx: PaymentContext, op: OperationRow): Promise<void> {
  const parts = op.key.split(":");
  switch (op.kind) {
    case "authorize": {
      const [order] = await ctx.db.select().from(paypalOrders).where(eq(paypalOrders.paypalOrderId, parts[1]));
      if (order) await authorizeBooking(ctx, order.bookingId, order.paypalOrderId, "system");
      return;
    }
    case "order-create": {
      const b = await getBooking(ctx.db, parts[1]);
      if (b.status === "pending_payment" && b.holdExpiresAt > ctx.now()) {
        await createOrderForBooking(ctx, b.id);
      } else {
        await failOp(ctx, op.key, "booking no longer payable");
      }
      return;
    }
    case "capture": {
      const kind = parts[1] as CaptureKind;
      const retry = parts[3]?.startsWith("retry-") ? Number(parts[3].slice(6)) : undefined;
      await captureBooking(ctx, parts[2], kind, retry ? { resumeRetry: retry } : {});
      return;
    }
    case "void": {
      if (op.key.endsWith(":fallback")) {
        await billViaInvoice(ctx, parts[1]);
        return;
      }
      const b = await getBooking(ctx.db, parts[1]);
      if (b.status === "cancelled" || b.status === "no_show") {
        await voidHold(ctx, b.id, b.status, "recovered");
      } else if (b.activeAuthorizationId) {
        // The remainder void after a fee capture (§9.4.3): just finish the call.
        const auth = await getAuthorization(ctx.db, b.activeAuthorizationId);
        const root = auth.parentAuthorizationId ? await getAuthorization(ctx.db, auth.parentAuthorizationId) : auth;
        await finishVoid(ctx, op, root.paypalAuthorizationId);
      }
      return;
    }
    case "void-orphan":
    case "void-replaced": {
      const [auth] = await ctx.db
        .select()
        .from(authorizations)
        .where(eq(authorizations.paypalAuthorizationId, parts[1]));
      if (!auth) return;
      if (op.kind === "void-orphan") {
        await voidOrphan(ctx, auth, "recovered");
      } else {
        await finishVoid(ctx, op, auth.paypalAuthorizationId);
        await ctx.db
          .update(authorizations)
          .set({ status: "VOIDED", updatedAt: ctx.now() })
          .where(eq(authorizations.id, auth.id));
      }
      return;
    }
    case "reauth": {
      if (op.bookingId) await reauthorizeBooking(ctx, op.bookingId);
      return;
    }
    case "payout":
      await sendPayout(ctx, parts[1]);
      return;
    case "payout-cancel": {
      const [payout] = await ctx.db.execute<{ paypal_item_id: string | null }>(
        sql`select paypal_item_id from payouts where id = ${parts[1]}`,
      );
      if (!payout?.paypal_item_id) return;
      const item = await getPayoutItem(ctx.paypal, payout.paypal_item_id);
      if (item.transaction_status !== "UNCLAIMED") {
        await ctx.db
          .update(paymentOperations)
          .set({ state: "succeeded", result: { status: item.transaction_status ?? null }, updatedAt: ctx.now() })
          .where(eq(paymentOperations.key, op.key));
        await syncPayout(ctx, parts[1]);
      }
      return;
    }
    case "invoice": {
      // invoice:<bookingId>:<seq> or fallback-invoice:<bookingId>
      const bookingId = op.key.startsWith("fallback-invoice:") ? parts[1] : parts[1];
      const seq = op.key.startsWith("fallback-invoice:") ? 0 : Number(parts[2]);
      const [row] = await ctx.db
        .select()
        .from(invoices)
        .where(and(eq(invoices.bookingId, bookingId), eq(invoices.seq, seq)));
      if (row) await issueInvoice(ctx, bookingId, row.invoiceNumber, op.key, "Holdline invoice.");
      return;
    }
  }
}

async function failOp(ctx: PaymentContext, key: string, reason: string) {
  await ctx.db
    .update(paymentOperations)
    .set({ state: "failed", lastError: reason, updatedAt: ctx.now() })
    .where(eq(paymentOperations.key, key));
}

/** Repeats a void under its own key and request ID; PREVIOUSLY_VOIDED or expired count as done. */
async function finishVoid(ctx: PaymentContext, op: OperationRow, paypalAuthorizationId: string) {
  const requestId = op.paypalRequestId ?? ctx.paypal.requestId("void", paypalAuthorizationId);
  await runOperation(ctx.db, {
    key: op.key,
    kind: op.kind,
    bookingId: op.bookingId,
    requestId,
    now: ctx.now,
    run: async () => {
      try {
        await voidAuthorization(ctx.paypal, paypalAuthorizationId, { requestId });
      } catch (error) {
        const done = alreadyDoneOutcome("void", error);
        if (done === "captured") throw new DefiniteOperationError("already captured");
        if (done !== "voided" && !(error instanceof PayPalApiError && /EXPIRED/.test(error.issue ?? ""))) throw error;
      }
      return { voided: paypalAuthorizationId };
    },
  });
}

/** Pending bookings with an open order: an approved order is authorized even if the tab was closed. */
async function openOrders(db: Db, now: Date) {
  return db
    .select({ bookingId: paypalOrders.bookingId, paypalOrderId: paypalOrders.paypalOrderId })
    .from(paypalOrders)
    .innerJoin(bookings, eq(bookings.id, paypalOrders.bookingId))
    .where(
      and(
        eq(bookings.status, "pending_payment"),
        eq(bookings.sample, false),
        inArray(paypalOrders.status, ["PAYER_ACTION_REQUIRED", "CREATED", "APPROVED"]),
        gt(paypalOrders.createdAt, new Date(now.getTime() - ORDER_CHASE_MS)),
      ),
    )
    .limit(BATCH);
}

async function chaseOrder(ctx: PaymentContext, bookingId: string, orderId: string) {
  // A live authorize belongs to its worker (or to the lease-expiry recovery above): don't wait on it here.
  if (await hasOperationInFlight(ctx.db, bookingId, `authorize:${orderId}`)) return;
  const order = await getOrder(ctx.paypal, orderId);
  await ctx.db
    .update(paypalOrders)
    .set({ status: order.status, updatedAt: ctx.now() })
    .where(eq(paypalOrders.paypalOrderId, orderId));
  if (order.status === "APPROVED" || order.status === "COMPLETED")
    await authorizeBooking(ctx, bookingId, orderId, "system");
}

/** Holds PayPal still has that our bookings don't use (§9.10): the reconciler voids them. */
async function orphanCandidates(db: Db) {
  const rows = await db
    .select({ auth: authorizations })
    .from(authorizations)
    .innerJoin(bookings, eq(bookings.id, authorizations.bookingId))
    .where(
      and(
        eq(authorizations.status, "CREATED"),
        isNull(authorizations.parentAuthorizationId),
        eq(bookings.sample, false),
        sql`(${authorizations.role} = 'orphan' or ${bookings.status} in ('expired', 'voided') or (${authorizations.role} = 'replaced'))`,
      ),
    )
    .limit(BATCH);
  return rows.map((r) => r.auth);
}

async function sentInvoiceIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.status, "sent")).limit(BATCH);
  return rows.map((r) => r.id);
}

async function pendingCaptureIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: captures.id }).from(captures).where(eq(captures.status, "PENDING")).limit(BATCH);
  return rows.map((r) => r.id);
}

/** Polls a PENDING capture (the webhook may never come). */
export async function refreshCapture(ctx: PaymentContext, captureId: string) {
  const [row] = await ctx.db.select().from(captures).where(eq(captures.id, captureId));
  if (!row) return;
  const remote = await getCapture(ctx.paypal, row.paypalCaptureId);
  if (remote.status === row.status) return;
  const { db } = ctx;
  if (remote.status === "COMPLETED" || remote.status === "DECLINED" || remote.status === "FAILED") {
    // Same mapping as the PAYMENT.CAPTURE.* webhook.
    await processCaptureStatus(ctx, row, remote.status);
    return;
  }
  const auth = await getAuthorization(db, row.authorizationId);
  await applyCapture(ctx, row.bookingId, row.kind as CaptureKind, auth, {
    paypalCaptureId: remote.id,
    status: remote.status,
    amountCents: payPalToCents(remote.amount.value),
    finalCapture: remote.final_capture ?? true,
  });
}

// ── 3. Expire unpaid ─────────────────────────────────────────────────────────────────────────────

async function unpaidExpired(db: Db, now: Date) {
  return db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.status, "pending_payment"),
        eq(bookings.sample, false),
        lt(bookings.holdExpiresAt, now),
        or(isNull(bookings.authorizingUntil), lt(bookings.authorizingUntil, now)),
      ),
    )
    .limit(BATCH);
}

/** pending_payment past its TTL, with no authorize in flight and no approved order → expired (ttl). */
export async function expireUnpaid(ctx: PaymentContext, bookingId: string): Promise<void> {
  if (await hasOperationInFlight(ctx.db, bookingId, "authorize:")) return;
  const [order] = await ctx.db
    .select()
    .from(paypalOrders)
    .where(
      and(
        eq(paypalOrders.bookingId, bookingId),
        inArray(paypalOrders.status, ["PAYER_ACTION_REQUIRED", "CREATED", "APPROVED"]),
      ),
    )
    .orderBy(sql`${paypalOrders.attempt} desc`)
    .limit(1);
  if (order) {
    // Unsure: ask PayPal. An approved order still inside the grace period gets authorized instead.
    const remote = await getOrder(ctx.paypal, order.paypalOrderId);
    if (remote.status === "APPROVED") {
      const result = await authorizeBooking(ctx, bookingId, order.paypalOrderId, "system");
      if (result.status !== "expired") return;
    }
  }
  const { changed } = await ctx.db.transaction(async (tx) => {
    const b = await getBooking(tx, bookingId);
    if (b.status !== "pending_payment" || b.holdExpiresAt > ctx.now()) return { changed: false };
    if (b.authorizingUntil && b.authorizingUntil > ctx.now()) return { changed: false };
    return transitionBooking(tx, {
      bookingId,
      from: "pending_payment",
      to: "expired",
      actor: "system",
      reason: "ttl",
      flag: null,
      patch: { cancelReason: "ttl" },
    });
  });
  if (changed) ctx.notify(bookingId, "expired");
}

// ── 4. Reauthorize, 5. stale holds ───────────────────────────────────────────────────────────────

async function dueReauthorizations(db: Db, now: Date): Promise<string[]> {
  const rows = await db
    .select({ bookingId: authorizations.bookingId })
    .from(authorizations)
    .innerJoin(bookings, eq(bookings.activeAuthorizationId, authorizations.id))
    .where(
      and(
        eq(bookings.status, "authorized"),
        eq(bookings.sample, false),
        isNull(bookings.paymentIssue),
        isNull(authorizations.parentAuthorizationId),
        isNotNull(authorizations.reauthorizeAt),
        lte(authorizations.reauthorizeAt, now),
      ),
    )
    .limit(BATCH);
  return rows.map((r) => r.bookingId);
}

async function staleHolds(db: Db, now: Date): Promise<string[]> {
  const rows = await db
    .select({
      id: bookings.id,
      slotEnd: bookings.slotEnd,
      policy: workspaces.policy,
      validUntil: authorizations.validUntil,
    })
    .from(bookings)
    .innerJoin(workspaces, eq(workspaces.id, bookings.workspaceId))
    .leftJoin(authorizations, eq(authorizations.id, bookings.activeAuthorizationId))
    .where(and(eq(bookings.status, "authorized"), eq(bookings.sample, false)))
    .limit(500);
  return rows
    .filter((r) => {
      const stale = r.slotEnd.getTime() + policyOf(r.policy).staleHoldHours * 3_600_000 < now.getTime();
      const nearExpiry = r.validUntil !== null && r.validUntil.getTime() - now.getTime() < DAY;
      return stale || nearExpiry;
    })
    .slice(0, BATCH)
    .map((r) => r.id);
}

// ── 8. Retention ─────────────────────────────────────────────────────────────────────────────────

/** PII older than 14 days, in all workspaces (SPEC §21). Aggregates and PayPal IDs stay. */
export async function purgeExpiredPii(db: Db, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
  await db
    .update(customers)
    .set({ name: null, email: null, phone: null, address: null, purgedAt: now })
    .where(and(lt(customers.createdAt, cutoff), isNull(customers.purgedAt)));
  await db
    .update(calls)
    .set({ transcript: null, messages: null, geminiContents: null, summary: null, updatedAt: now })
    .where(
      and(
        lt(calls.createdAt, cutoff),
        eq(calls.sample, false),
        sql`(${calls.transcript} is not null or ${calls.messages} is not null)`,
      ),
    );
  await db.delete(vapiEvents).where(lt(vapiEvents.receivedAt, cutoff));
  await db
    .update(webhookEvents)
    .set({ raw: {} })
    .where(
      and(
        lt(webhookEvents.receivedAt, cutoff),
        isNotNull(webhookEvents.processedAt),
        sql`${webhookEvents.raw} <> '{}'::jsonb`,
      ),
    );
  await db
    .update(outboxEmails)
    .set({ to: null, html: null })
    .where(and(lt(outboxEmails.createdAt, cutoff), isNotNull(outboxEmails.to)));
  await db
    .update(emailIdentities)
    .set({ email: null })
    .where(and(lt(emailIdentities.createdAt, cutoff), isNotNull(emailIdentities.email)));
}
