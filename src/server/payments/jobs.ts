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
  payouts,
  paypalOrders,
  rateCounters,
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
import { getAuthorization as getPayPalAuthorization, getCapture, voidAuthorization } from "@/server/paypal/payments";
import { purgeDemoWorkspacePii, recentlyResetWorkspaceIds, releaseDemoWorkspaceHolds } from "@/server/workspaces/reset";

import { applyAuthorization, type AuthInfo, authorizeBooking, createOrderForBooking, voidOrphan } from "./authorize";
import { applyCapture, captureBooking, type CaptureInfo, type CaptureKind } from "./capture";
import { processCaptureStatus } from "./capture-status";
import type { PaymentContext } from "./context";
import { billViaInvoice, issueInvoice, syncInvoice } from "./invoices";
import {
  DefiniteOperationError,
  hasOperationInFlight,
  markApplied,
  markOperationFailed,
  type OperationRow,
  runOperation,
  unappliedOperations,
} from "./ledger";
import { cancelUnclaimed, pendingPayoutIds, processingPayoutIds, sendPayout, syncPayout } from "./payouts";
import { getAuthorization, getBooking } from "./queries";
import { linkReauthorizedChild, reauthorizeBooking } from "./reauthorize";
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
    await each("reconcile_ops", await expiredOperations(db, now), (op) =>
      resumeOperation(ctx, op).finally(() => backOff(ctx, op)),
    );
    await each("reconcile_applied", await unappliedOperations(db, new Date(now.getTime() - 30_000), BATCH), (op) =>
      reapplyOperation(ctx, op),
    );
    await each("reconcile_pending_auths", await pendingAuthorizationRows(db), (auth) =>
      refreshAuthorization(ctx, auth),
    );
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
    // 5. Release stale holds, and the holds of demo copies reset in the last hour (SPEC §17): one an
    // authorize placed while the reset ran, or a release the reset's own attempt didn't finish.
    await each("stale_holds", await staleHolds(db, now), (bookingId) => releaseStaleHold(ctx, bookingId));
    await each("reset_holds", await recentlyResetWorkspaceIds(db, now), (id) => releaseDemoWorkspaceHolds(ctx, id));
    // 6. Payouts
    await each("payouts_sent", await pendingPayoutIds(db, BATCH), (id) => sendPayout(ctx, id));
    // 7. Summaries: stage 8.
  }
  // 8. Retention (no PayPal needed). A copy reset in the last hour is purged again: a late write that
  // raced the reset (e.g. a conversation created during it) is cleared within one tick.
  await each("retention", [now], (at) => purgeExpiredPii(db, at));
  await each("reset_purge", await recentlyResetWorkspaceIds(db, now), (id) => purgeDemoWorkspacePii(db, id, now));
  return report;
}

// ── 1. Reconcile ─────────────────────────────────────────────────────────────────────────────────

async function expiredOperations(db: Db, now: Date): Promise<OperationRow[]> {
  return db
    .select()
    .from(paymentOperations)
    .where(and(eq(paymentOperations.state, "in_flight"), lt(paymentOperations.leaseUntil, now)))
    .orderBy(paymentOperations.updatedAt)
    .limit(BATCH);
}

/** Give up on a row nobody can settle after this many resume attempts (it is alerted, never silently lost). */
const MAX_RESUMES = 30;

/**
 * After a resume: a row still in flight with an expired lease was not taken over (the domain state moved
 * on, or PayPal was unreachable). Back it off so other rows get their turn; abandon it after MAX_RESUMES.
 */
async function backOff(ctx: PaymentContext, op: OperationRow) {
  const [row] = await ctx.db.select().from(paymentOperations).where(eq(paymentOperations.key, op.key));
  if (!row || row.state !== "in_flight" || row.leaseUntil > ctx.now()) return;
  if (row.attempts >= MAX_RESUMES) {
    await failOp(ctx, op.key, "abandoned after repeated recovery attempts");
    console.error(`[holdline] ALERT ledger operation ${op.kind} for booking ${op.bookingId ?? "?"} abandoned`);
    return;
  }
  await ctx.db
    .update(paymentOperations)
    .set({
      attempts: sql`${paymentOperations.attempts} + 1`,
      leaseUntil: new Date(ctx.now().getTime() + 5 * 60_000),
      updatedAt: ctx.now(),
    })
    .where(and(eq(paymentOperations.key, op.key), eq(paymentOperations.state, "in_flight")));
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
      const reapproval =
        b.status === "authorized" && (b.paymentIssue === "reauth_failed" || b.paymentIssue === "hold_lost");
      if ((b.status === "pending_payment" && b.holdExpiresAt > ctx.now()) || reapproval) {
        await createOrderForBooking(ctx, b.id);
      } else {
        // An order for a booking nobody can pay any more holds no money: stop chasing it.
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
      if (op.key.includes(":fallback")) {
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
      if (op.bookingId) await reauthorizeBooking(ctx, op.bookingId, { resume: true });
      return;
    }
    case "payout":
      await sendPayout(ctx, parts[1]);
      return;
    case "payout-cancel": {
      const [row] = await ctx.db.select().from(payouts).where(eq(payouts.id, parts[1]));
      if (row) await cancelUnclaimed(ctx, row);
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
        // Pending bookings, and re-approvals of authorized ones (SPEC §9.8).
        or(
          eq(bookings.status, "pending_payment"),
          and(eq(bookings.status, "authorized"), inArray(bookings.paymentIssue, ["reauth_failed", "hold_lost"])),
        ),
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
    authorizationId: auth.id,
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

/** A placeholder older than this can't belong to a call that is still being created. */
const PLACEHOLDER_MAX_AGE_MS = 60 * 60_000;

/**
 * PII older than 14 days, in all workspaces (SPEC §21). Aggregates and PayPal IDs stay. Also deletes
 * expired rate counters (they carry no PII, but nothing else removes them).
 */
export async function purgeExpiredPii(db: Db, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY);
  await db
    .update(customers)
    .set({ name: null, email: null, phone: null, address: null, purgedAt: now })
    .where(and(lt(customers.createdAt, cutoff), isNull(customers.purgedAt)));
  // The caller's own description of the problem (SPEC §19); seeded sample text stays.
  await db
    .update(bookings)
    .set({ problemSummary: null, updatedAt: now })
    .where(and(lt(bookings.createdAt, cutoff), eq(bookings.sample, false), isNotNull(bookings.problemSummary)));
  await db
    .update(calls)
    .set({ transcript: null, messages: null, geminiContents: null, summary: null, caller: null, updatedAt: now })
    .where(
      and(
        lt(calls.createdAt, cutoff),
        eq(calls.sample, false),
        sql`(${calls.transcript} is not null or ${calls.messages} is not null or ${calls.caller} is not null)`,
      ),
    );
  // A web-call placeholder whose Vapi call was never created (the server died before the undo).
  await db
    .delete(calls)
    .where(
      and(
        eq(calls.status, "creating"),
        isNull(calls.vapiCallId),
        lt(calls.createdAt, new Date(now.getTime() - PLACEHOLDER_MAX_AGE_MS)),
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
  await db.delete(rateCounters).where(lt(rateCounters.expiresAt, now));
}

// ── Ledger results not yet reflected in the domain tables ─────────────────────────────────────────

/**
 * Re-applies a succeeded operation from its stored result when the domain write never happened (a crash
 * or DB error right after PayPal answered), then marks it applied. Every apply step is idempotent.
 */
export async function reapplyOperation(ctx: PaymentContext, op: OperationRow): Promise<void> {
  const { db } = ctx;
  const parts = op.key.split(":");
  switch (op.kind) {
    case "order-create": {
      const result = op.result as { orderId?: string } | null;
      const b = await getBooking(db, parts[1]);
      if (result?.orderId) {
        await db
          .insert(paypalOrders)
          .values({
            bookingId: b.id,
            paypalOrderId: result.orderId,
            attempt: Number(parts[2]),
            status: "PAYER_ACTION_REQUIRED",
            amountCents: b.priceCents,
          })
          .onConflictDoNothing();
      }
      break;
    }
    case "authorize": {
      const info = op.result as AuthInfo | null;
      if (!info) break;
      const [stored] = await db
        .select()
        .from(authorizations)
        .where(eq(authorizations.paypalAuthorizationId, info.paypalAuthorizationId));
      const [order] = await db.select().from(paypalOrders).where(eq(paypalOrders.paypalOrderId, parts[1]));
      if (!stored && order) await applyAuthorization(ctx, order.bookingId, order.paypalOrderId, info, "system");
      break;
    }
    case "capture": {
      const info = op.result as CaptureInfo | null;
      if (!info || !op.bookingId) break;
      const [stored] = await db.select().from(captures).where(eq(captures.paypalCaptureId, info.paypalCaptureId));
      if (!stored) {
        const b = await getBooking(db, op.bookingId);
        const authId = info.authorizationId ?? b.activeAuthorizationId;
        if (authId)
          await applyCapture(ctx, op.bookingId, parts[1] as CaptureKind, await getAuthorization(db, authId), info);
      }
      // A declined or failed capture frees its key for an owner retry once the flag is in place.
      if (info.status === "DECLINED" || info.status === "FAILED") {
        await markOperationFailed(db, op.key, `capture ${info.status}`);
        return;
      }
      break;
    }
    case "void": {
      if (op.key.includes(":fallback") || !op.bookingId) break;
      const b = await getBooking(db, op.bookingId);
      if (b.status === "cancelled" || b.status === "no_show") await voidHold(ctx, b.id, b.status, "recovered");
      break;
    }
    case "void-orphan":
    case "void-replaced": {
      await db
        .update(authorizations)
        .set({ status: "VOIDED", updatedAt: ctx.now() })
        .where(eq(authorizations.paypalAuthorizationId, parts[1]));
      break;
    }
    case "reauth": {
      const child = op.result as {
        paypalAuthorizationId: string;
        status: string;
        amountCents: number;
        createTime: string | null;
        expirationTime: string | null;
      } | null;
      const [parent] = await db.select().from(authorizations).where(eq(authorizations.paypalAuthorizationId, parts[1]));
      const [linked] = child
        ? await db
            .select()
            .from(authorizations)
            .where(eq(authorizations.paypalAuthorizationId, child.paypalAuthorizationId))
        : [];
      if (child && parent && child.status === "CREATED" && linked?.parentAuthorizationId !== parent.id) {
        await db.transaction((tx) =>
          linkReauthorizedChild(tx, {
            bookingId: parent.bookingId,
            parent,
            child: { ...child, validUntil: child.expirationTime ? new Date(child.expirationTime) : parent.validUntil },
            now: ctx.now(),
          }),
        );
      }
      break;
    }
    case "payout": {
      const result = op.result as { payoutBatchId?: string } | null;
      const [row] = await db.select().from(payouts).where(eq(payouts.id, parts[1]));
      if (row && result?.payoutBatchId && !row.paypalBatchId) {
        await db
          .update(payouts)
          .set({ paypalBatchId: result.payoutBatchId, status: "processing", updatedAt: ctx.now() })
          .where(and(eq(payouts.id, row.id), eq(payouts.status, "pending")));
        await syncPayout(ctx, row.id);
      }
      break;
    }
    case "payout-cancel":
      await syncPayout(ctx, parts[1]);
      break;
    case "invoice": {
      const result = op.result as { paypalInvoiceId?: string; payerViewUrl?: string | null } | null;
      const fallback = op.key.startsWith("fallback-invoice:");
      const [row] = await db
        .select()
        .from(invoices)
        .where(and(eq(invoices.bookingId, parts[1]), eq(invoices.seq, fallback ? 0 : Number(parts[2]))));
      if (row && result?.paypalInvoiceId && row.status === "draft") {
        await db
          .update(invoices)
          .set({
            paypalInvoiceId: result.paypalInvoiceId,
            payerViewUrl: result.payerViewUrl ?? null,
            status: "sent",
            updatedAt: ctx.now(),
          })
          .where(and(eq(invoices.id, row.id), eq(invoices.status, "draft")));
      }
      break;
    }
  }
  await markApplied(db, op.key, ctx.now());
}

// ── PENDING authorizations (the webhook may never come) ──────────────────────────────────────────

async function pendingAuthorizationRows(db: Db) {
  const rows = await db
    .select({ auth: authorizations })
    .from(authorizations)
    .innerJoin(bookings, eq(bookings.id, authorizations.bookingId))
    .where(and(eq(authorizations.status, "PENDING"), eq(bookings.sample, false)))
    .limit(BATCH);
  return rows.map((r) => r.auth);
}

/** GETs a PENDING authorization; once it settles, apply it (authorize, decline, or void as an orphan). */
async function refreshAuthorization(ctx: PaymentContext, auth: typeof authorizations.$inferSelect) {
  const remote = await getPayPalAuthorization(ctx.paypal, auth.paypalAuthorizationId);
  if (remote.status === "PENDING" || !auth.paypalOrderId) return;
  await applyAuthorization(
    ctx,
    auth.bookingId,
    auth.paypalOrderId,
    {
      paypalAuthorizationId: remote.id,
      status: remote.status,
      amountCents: payPalToCents(remote.amount.value),
      createTime: remote.create_time ?? null,
      expirationTime: remote.expiration_time ?? null,
    },
    "system",
  );
}
