import { and, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import {
  authorizations,
  bookings,
  calls,
  captures,
  customers,
  emailIdentities,
  invoices,
  outboxEmails,
  payouts,
  paypalOrders,
  vapiEvents,
  webhookEvents,
  workspaces,
} from "@/db/schema";
import type { Db, Tx } from "@/db/types";
import { dbErrorCode } from "@/server/db-error";
import { lockBooking } from "@/server/domain/transition";
import type { PaymentContext } from "@/server/payments/context";
import { claimOperation, hasOperationInFlight, resumableKey } from "@/server/payments/ledger";
import { cancelBooking, releaseStaleHold, voidHold } from "@/server/payments/void";
import { sendControl } from "@/server/vapi/control";

/** How long after a reset the tick repeats its purge and hold release (SPEC §12, job 8), as a backstop. */
export const RESET_BACKSTOP_MS = 60 * 60_000;

/**
 * "Start a fresh demo" (SPEC §17, §21): hard-deletes the PII of one demo copy right away, instead of
 * waiting for the 14-day retention job, and marks the copy as reset. The same fields as that job
 * (customers, the bookings' problem summaries, the conversations' transcripts, messages, model
 * contents, summaries and caller details, raw Vapi payloads, raw PayPal webhook payloads, outbox
 * recipients and bodies, confirmed emails), but for this workspace only and regardless of age.
 * Aggregates, refs and PayPal IDs stay. Never touches the main or the phone-demo workspace.
 *
 * Idempotent: the tick runs it again for an hour after the reset, for writes that raced it.
 */
export async function purgeDemoWorkspacePii(db: Db, workspaceId: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    // The marker, in the same transaction: from its commit on the guard rejects the copy and late
    // writers keep no PII in it (fence.ts). The first reset time stays.
    const [ws] = await tx
      .update(workspaces)
      .set({ resetAt: sql`coalesce(${workspaces.resetAt}, ${now.toISOString()}::timestamptz)` })
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, "demo")))
      .returning({ id: workspaces.id });
    if (!ws) return false;
    // Every conversation of the copy, locked before anything is cleared (the other half of the fence):
    // a booking a tool call is writing right now commits first and is cleared below.
    await tx.select({ id: calls.id }).from(calls).where(eq(calls.workspaceId, workspaceId)).for("update");

    await tx
      .update(customers)
      .set({ name: null, email: null, phone: null, address: null, purgedAt: now })
      .where(and(eq(customers.workspaceId, workspaceId), isNull(customers.purgedAt)));
    // The caller's own description of the problem (SPEC §19); the seeded sample text stays.
    await tx
      .update(bookings)
      .set({ problemSummary: null, updatedAt: now })
      .where(
        and(eq(bookings.workspaceId, workspaceId), eq(bookings.sample, false), isNotNull(bookings.problemSummary)),
      );
    await tx.delete(vapiEvents).where(
      inArray(
        vapiEvents.vapiCallId,
        tx
          .select({ id: calls.vapiCallId })
          .from(calls)
          .where(and(eq(calls.workspaceId, workspaceId), isNotNull(calls.vapiCallId))),
      ),
    );
    await tx
      .update(calls)
      .set({ transcript: null, messages: null, geminiContents: null, summary: null, caller: null, updatedAt: now })
      .where(eq(calls.workspaceId, workspaceId));
    // PayPal's payloads can carry payer details, e.g. the invoice recipient's email (SPEC §21). Only
    // processed events: an unprocessed one still has to be applied (the retention job clears it later).
    const resourceIds = await paypalResourceIds(tx, workspaceId);
    if (resourceIds.length > 0) {
      await tx
        .update(webhookEvents)
        .set({ raw: {} })
        .where(
          and(
            inArray(webhookEvents.resourceId, resourceIds),
            isNotNull(webhookEvents.processedAt),
            sql`${webhookEvents.raw} <> '{}'::jsonb`,
          ),
        );
    }
    await tx.update(outboxEmails).set({ to: null, html: null }).where(eq(outboxEmails.workspaceId, workspaceId));
    await tx.update(emailIdentities).set({ email: null }).where(eq(emailIdentities.workspaceId, workspaceId));
    return true;
  });
}

/** The marker alone, for when the purge itself failed: the copy is dead, and the tick's backstop purges it. */
export async function markDemoWorkspaceReset(db: Db, workspaceId: string, now: Date): Promise<void> {
  await db
    .update(workspaces)
    .set({ resetAt: sql`coalesce(${workspaces.resetAt}, ${now.toISOString()}::timestamptz)` })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, "demo")));
}

/** The PayPal resource IDs of one workspace, as PayPal's webhooks name them in `resource.id`. */
async function paypalResourceIds(tx: Tx, workspaceId: string): Promise<string[]> {
  const ofWorkspace = eq(bookings.workspaceId, workspaceId);
  const rows = await unionAll(
    tx
      .select({ id: sql<string | null>`${paypalOrders.paypalOrderId}` })
      .from(paypalOrders)
      .innerJoin(bookings, eq(bookings.id, paypalOrders.bookingId))
      .where(ofWorkspace),
    tx
      .select({ id: sql<string | null>`${authorizations.paypalAuthorizationId}` })
      .from(authorizations)
      .innerJoin(bookings, eq(bookings.id, authorizations.bookingId))
      .where(ofWorkspace),
    tx
      .select({ id: sql<string | null>`${captures.paypalCaptureId}` })
      .from(captures)
      .innerJoin(bookings, eq(bookings.id, captures.bookingId))
      .where(ofWorkspace),
    tx
      .select({ id: sql<string | null>`${invoices.paypalInvoiceId}` })
      .from(invoices)
      .innerJoin(bookings, eq(bookings.id, invoices.bookingId))
      .where(ofWorkspace),
    tx
      .select({ id: sql<string | null>`${payouts.paypalBatchId}` })
      .from(payouts)
      .where(eq(payouts.workspaceId, workspaceId)),
    tx
      .select({ id: sql<string | null>`${payouts.paypalItemId}` })
      .from(payouts)
      .where(eq(payouts.workspaceId, workspaceId)),
  );
  return [...new Set(rows.map((r) => r.id).filter((id): id is string => Boolean(id)))];
}

/**
 * Before the purge: ends the copy's live web calls through their controlUrl (best effort, in
 * parallel, 3 s each), so the assistant stops listening and the end-of-call report comes in now.
 * The fence keeps that report's transcript out of the purged copy either way.
 */
export async function endDemoWorkspaceCalls(db: Db, workspaceId: string): Promise<number> {
  const live = await db
    .select({ id: calls.id, controlUrl: calls.controlUrl })
    .from(calls)
    .where(
      and(
        eq(calls.workspaceId, workspaceId),
        eq(calls.channel, "web"),
        ne(calls.status, "ended"),
        isNull(calls.endedAt),
        isNotNull(calls.controlUrl),
      ),
    );
  const outcomes = await Promise.all(
    live.map(async (c) => {
      const outcome = await sendControl(c.controlUrl!, { type: "end-call" });
      if (!outcome.ok) {
        console.warn(`[holdline] reset: end-call for call ${c.id} failed (${outcome.status ?? outcome.error})`);
      }
      return outcome.ok;
    }),
  );
  return outcomes.filter(Boolean).length;
}

/**
 * The money side of a reset: nothing of the old copy stays open on the shared sandbox buyers, and
 * nothing is charged (the reset dialog's promise):
 * - an approved hold is released (the stale-hold path: authorized → cancelled → voided);
 * - a booking still waiting for approval is withdrawn, so its pay link can't place a new hold;
 * - a cancelled booking whose release didn't finish is released again;
 * - a no-show or late cancel whose fee capture was declined (capture_failed) is released without the
 *   fee, as Waive fee does, unless a capture is still running or a fallback invoice is open (that
 *   one already released the hold).
 * A completed job whose capture failed keeps its hold: the work was done, the state machine has no
 * completed → voided, and PayPal lets the authorization lapse.
 *
 * Sample history is never touched. Each booking on its own; failures are logged as codes. An
 * authorize running during the reset can't be withdrawn (409 authorizing): the tick runs this again
 * for an hour after the reset (RESET_BACKSTOP_MS), which releases the hold it then placed.
 */
export async function releaseDemoWorkspaceHolds(ctx: PaymentContext, workspaceId: string): Promise<number> {
  const open = await ctx.db
    .select({ id: bookings.id, status: bookings.status })
    .from(bookings)
    .where(
      and(
        eq(bookings.workspaceId, workspaceId),
        eq(bookings.sample, false),
        or(
          inArray(bookings.status, ["pending_payment", "authorized"]),
          and(inArray(bookings.status, ["no_show", "cancelled"]), eq(bookings.paymentIssue, "capture_failed")),
          and(
            eq(bookings.status, "cancelled"),
            or(isNull(bookings.cancelReason), ne(bookings.cancelReason, "late")),
            isNull(bookings.paymentIssue),
          ),
        ),
      ),
    );
  let released = 0;
  for (const b of open) {
    try {
      if (b.status === "authorized") await releaseStaleHold(ctx, b.id);
      else if (b.status === "pending_payment") await cancelBooking(ctx, b.id, "system");
      else if (!(await releaseFailedFeeHold(ctx, b.id))) continue;
      released += 1;
    } catch (error) {
      console.error(`[holdline] reset: releasing booking ${b.id} failed: ${dbErrorCode(error)}`);
    }
  }
  return released;
}

/**
 * no_show / cancelled → voided without a fee (reason `reset`). The checks and the void claim run under
 * the booking lock, as in Waive fee: Bill via invoice and Retry capture take the same lock. Returns
 * false when the booking is left alone (a capture running, an open fallback invoice, already captured).
 */
async function releaseFailedFeeHold(ctx: PaymentContext, bookingId: string): Promise<boolean> {
  const decision = await ctx.db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    if (b.sample || (b.status !== "no_show" && b.status !== "cancelled")) return null;
    const failedFee = b.paymentIssue === "capture_failed";
    const pendingRelease = b.status === "cancelled" && b.cancelReason !== "late" && b.paymentIssue === null;
    if (!failedFee && !pendingRelease) return null;
    if (await hasOperationInFlight(tx, bookingId, "capture:")) return null;
    const [openInvoice] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.bookingId, bookingId),
          eq(invoices.kind, "fallback"),
          inArray(invoices.status, ["draft", "sent"]),
        ),
      );
    if (openInvoice) return null;
    const [captured] = await tx
      .select({ id: captures.id })
      .from(captures)
      .where(and(eq(captures.bookingId, bookingId), inArray(captures.status, ["COMPLETED", "PENDING"])));
    if (captured) return null;
    const attempt = await resumableKey(tx, `void:${bookingId}`);
    const claimed = await claimOperation(tx, {
      key: attempt.key,
      kind: "void",
      bookingId,
      requestId: ctx.paypal.requestId("void", bookingId, ...(attempt.n ? [`r${attempt.n}`] : [])),
      now: ctx.now(),
    });
    return { from: b.status, attempt, claimed };
  });
  if (!decision) return false;
  // Only a key we just claimed runs directly; an existing attempt is waited for or replayed.
  await voidHold(ctx, bookingId, decision.from, "reset", "system", decision.claimed ? decision.attempt : undefined);
  return true;
}

/** Demo copies reset within the backstop window, for the tick to purge and release again. */
export async function recentlyResetWorkspaceIds(db: Db, now: Date): Promise<string[]> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.kind, "demo"),
        gt(workspaces.resetAt, new Date(now.getTime() - RESET_BACKSTOP_MS)),
        lte(workspaces.resetAt, now),
      ),
    );
  return rows.map((r) => r.id);
}
