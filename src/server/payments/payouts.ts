import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { bookings, captures, invoices, paymentOperations, payouts, technicians } from "@/db/schema";
import type { Executor, Tx } from "@/db/types";
import { payoutCents } from "@/server/domain/pricing";
import { lockBooking, setPaymentIssue, transitionBooking } from "@/server/domain/transition";
import { readVar } from "@/server/config/env";
import {
  cancelUnclaimedItem,
  createPayout,
  duplicateBatchId,
  getPayoutBatch,
  payoutIds,
  payoutItemOutcome,
  type PayoutItemStatus,
} from "@/server/paypal/payouts";

import { type PaymentContext, PaymentStateError } from "./context";
import { isDefiniteFailure, OperationFailedError, OperationInProgressError, runOperation } from "./ledger";

export type PayoutRow = typeof payouts.$inferSelect;

/**
 * Creates the payout row for recognised money, inside the transaction that recognises it (SPEC §9.9).
 * The natural key (source, source_id, technician, attempt) makes every path idempotent.
 */
export async function createPayoutRow(
  tx: Tx,
  input: {
    instanceId: string;
    workspaceId: string;
    bookingId: string;
    technicianId: string;
    source: "capture" | "invoice";
    sourceId: string;
    recognisedCents: number;
    attemptNo?: number;
  },
): Promise<void> {
  const [tech] = await tx.select().from(technicians).where(eq(technicians.id, input.technicianId));
  if (!tech) throw new Error("technician not found");
  const amountCents = payoutCents(input.recognisedCents, tech.payoutShareBps);
  if (amountCents <= 0) return;
  const attemptNo = input.attemptNo ?? 1;
  const ids = payoutIds({
    instanceId: input.instanceId,
    source: input.source,
    sourceId: input.sourceId,
    technicianKey: tech.key,
    attempt: attemptNo,
  });
  await tx
    .insert(payouts)
    .values({
      workspaceId: input.workspaceId,
      bookingId: input.bookingId,
      source: input.source,
      sourceId: input.sourceId,
      technicianId: tech.id,
      attemptNo,
      amountCents,
      senderBatchId: ids.senderBatchId,
      senderItemId: ids.senderItemId,
    })
    .onConflictDoNothing();
}

/** POST /v1/payments/payouts through the ledger (SPEC §9.9.2), then a first status sync. */
export async function sendPayout(ctx: PaymentContext, payoutId: string): Promise<PayoutRow> {
  const { db, paypal } = ctx;
  const row = await getPayout(db, payoutId);
  if (row.status !== "pending" || row.sample) return row;
  const [tech] = await db.select().from(technicians).where(eq(technicians.id, row.technicianId));
  if (!tech?.payoutEmail) return row; // waits until the technician's sandbox email is configured
  const [booking] = await db.select({ ref: bookings.ref }).from(bookings).where(eq(bookings.id, row.bookingId));

  try {
    const { result } = await runOperation(db, {
      key: `payout:${payoutId}`,
      kind: "payout",
      bookingId: row.bookingId,
      requestId: paypal.requestId("payout", row.senderItemId),
      now: ctx.now,
      run: async () => {
        try {
          const created = await createPayout(paypal, {
            senderBatchId: row.senderBatchId,
            senderItemId: row.senderItemId,
            receiverEmail: tech.payoutEmail!,
            amountCents: row.amountCents,
            currency: "USD",
            note: `Holdline payout for ${booking?.ref ?? "a job"}`,
            emailSubject: "You have a Holdline payout",
            emailMessage: `Your share for ${booking?.ref ?? "a job"} (sandbox).`,
          });
          return { payoutBatchId: created.payoutBatchId };
        } catch (error) {
          // A repeated sender_batch_id: PayPal already has this batch; follow its link (sandbox report row 17).
          const original = duplicateBatchId(error);
          if (original) return { payoutBatchId: original };
          throw error;
        }
      },
    });
    await db
      .update(payouts)
      .set({ paypalBatchId: result.payoutBatchId, status: "processing", updatedAt: ctx.now() })
      .where(and(eq(payouts.id, payoutId), eq(payouts.status, "pending")));
  } catch (error) {
    if (error instanceof OperationInProgressError) return getPayout(db, payoutId);
    // Only a definite refusal of the create marks the row failed. Anything else (e.g. our DB write after
    // PayPal accepted) leaves it pending: the next send replays the ledger result.
    if (!(error instanceof OperationFailedError) && !isDefiniteFailure(error)) throw error;
    await db
      .update(payouts)
      .set({ status: "failed", transactionStatus: "CREATE_FAILED", updatedAt: ctx.now() })
      .where(and(eq(payouts.id, payoutId), eq(payouts.status, "pending")));
    await flagPayoutFailed(ctx, row.bookingId);
    return getPayout(db, payoutId);
  }
  return syncPayout(ctx, payoutId);
}

/** GETs the batch and maps the item status (SPEC §9.9.3); moves the booking to paid_out when complete. */
export async function syncPayout(ctx: PaymentContext, payoutId: string): Promise<PayoutRow> {
  const { db, paypal } = ctx;
  const row = await getPayout(db, payoutId);
  if (!row.paypalBatchId || row.sample) return row;
  const batch = await getPayoutBatch(paypal, row.paypalBatchId);
  const item = batch.items?.find((i) => i.payout_item?.sender_item_id === row.senderItemId) ?? batch.items?.[0];
  const status: PayoutItemStatus | undefined =
    batch.batch_header.batch_status === "DENIED" ? "FAILED" : item?.transaction_status;
  const outcome = payoutItemOutcome(status);
  const next =
    outcome === "succeeded"
      ? "succeeded"
      : outcome === "retryable"
        ? "failed"
        : outcome === "cancel_first"
          ? "unclaimed"
          : outcome === "needs_review"
            ? "needs_review"
            : "processing";
  // Terminal rows never move again. A cancelling row follows PayPal (the recipient may still claim it,
  // or it comes back RETURNED) but doesn't fall back to unclaimed while the cancel is open.
  const movable =
    row.status === "processing" || row.status === "unclaimed" || (row.status === "cancelling" && next !== "unclaimed");
  if (movable && next !== row.status) {
    await db
      .update(payouts)
      .set({
        status: next,
        paypalItemId: item?.payout_item_id ?? row.paypalItemId,
        transactionStatus: status ?? null,
        updatedAt: ctx.now(),
      })
      .where(eq(payouts.id, payoutId));
  } else {
    await db
      .update(payouts)
      .set({ paypalItemId: row.paypalItemId ?? item?.payout_item_id ?? null, updatedAt: ctx.now() })
      .where(eq(payouts.id, payoutId));
  }
  if (next === "failed" || next === "unclaimed" || next === "needs_review") await flagPayoutFailed(ctx, row.bookingId);
  if (next === "succeeded") await maybePaidOut(ctx, row.bookingId);
  return getPayout(db, payoutId);
}

async function flagPayoutFailed(ctx: PaymentContext, bookingId: string) {
  await ctx.db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    if (b.status === "captured" && b.paymentIssue === null) {
      await setPaymentIssue(tx, { bookingId, flag: "payout_failed", actor: "system", reason: "payout_failed" });
    }
  });
}

/**
 * The main payouts of a booking: those for its captures and for a paid fallback invoice. Extra-work
 * invoices have their own lifecycle (SPEC §9.6).
 */
async function mainPayouts(db: Executor, bookingId: string): Promise<PayoutRow[]> {
  const rows = await db.select().from(payouts).where(eq(payouts.bookingId, bookingId));
  const fallback = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.bookingId, bookingId), eq(invoices.kind, "fallback")));
  const fallbackIds = new Set(fallback.map((f) => f.id));
  return rows.filter((r) => r.source === "capture" || fallbackIds.has(r.sourceId));
}

/** captured → paid_out once the newest attempt of every main payout succeeded (SPEC §9.9.3). */
export async function maybePaidOut(ctx: PaymentContext, bookingId: string): Promise<void> {
  const { db } = ctx;
  const rows = await mainPayouts(db, bookingId);
  const newest = new Map<string, PayoutRow>();
  for (const r of rows) {
    const k = `${r.source}:${r.sourceId}:${r.technicianId}`;
    if ((newest.get(k)?.attemptNo ?? 0) < r.attemptNo) newest.set(k, r);
  }
  if (newest.size === 0 || [...newest.values()].some((r) => r.status !== "succeeded")) return;
  await db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    if (b.status !== "captured" || b.paymentIssue === "capture_pending" || b.paymentIssue === "capture_failed") return;
    await transitionBooking(tx, {
      bookingId,
      from: "captured",
      to: "paid_out",
      actor: "system",
      reason: "payouts_succeeded",
    });
  });
}

/**
 * Retry payout (SPEC §9.9.4): only from FAILED/RETURNED/BLOCKED; an UNCLAIMED item is cancelled first.
 * Creates the next attempt row under the natural key, then sends it.
 */
export async function retryPayout(ctx: PaymentContext, payoutId: string): Promise<PayoutRow> {
  const { db, paypal } = ctx;
  let row = await getPayout(db, payoutId);
  if (row.sample) throw new PaymentStateError("Sample payouts are read-only.");
  // A send whose result we never recorded: sync that batch instead of paying a second time.
  const [sent] = await db
    .select()
    .from(paymentOperations)
    .where(eq(paymentOperations.key, `payout:${payoutId}`));
  if (sent?.state === "in_flight") throw new PaymentStateError("This payout is still being sent.", 409, "in_progress");
  const sentBatch = (sent?.result as { payoutBatchId?: string } | null)?.payoutBatchId;
  if (sent?.state === "succeeded" && sentBatch && !row.paypalBatchId) {
    await db
      .update(payouts)
      .set({ paypalBatchId: sentBatch, status: "processing", updatedAt: ctx.now() })
      .where(eq(payouts.id, payoutId));
    row = await syncPayout(ctx, payoutId);
  }
  if (row.status === "unclaimed" || row.status === "cancelling") row = await cancelUnclaimed(ctx, row);
  if (row.status !== "failed") {
    throw new PaymentStateError("Only a failed or returned payout can be retried.", 409, "payout_not_failed");
  }
  const [newer] = await db
    .select()
    .from(payouts)
    .where(
      and(
        eq(payouts.source, row.source),
        eq(payouts.sourceId, row.sourceId),
        eq(payouts.technicianId, row.technicianId),
        sql`${payouts.attemptNo} > ${row.attemptNo}`,
      ),
    )
    .orderBy(desc(payouts.attemptNo))
    .limit(1);
  if (newer) return newer.status === "pending" ? sendPayout(ctx, newer.id) : newer;

  const [booking] = await db.select().from(bookings).where(eq(bookings.id, row.bookingId));
  const recognised = await recognisedFor(db, row);
  await db.transaction((tx) =>
    createPayoutRow(tx, {
      instanceId: paypal.instanceId,
      workspaceId: booking.workspaceId,
      bookingId: row.bookingId,
      technicianId: row.technicianId,
      source: row.source,
      sourceId: row.sourceId,
      recognisedCents: recognised,
      attemptNo: row.attemptNo + 1,
    }),
  );
  const [next] = await db
    .select()
    .from(payouts)
    .where(
      and(
        eq(payouts.source, row.source),
        eq(payouts.sourceId, row.sourceId),
        eq(payouts.technicianId, row.technicianId),
        eq(payouts.attemptNo, row.attemptNo + 1),
      ),
    );
  await ctx.db.transaction((tx) =>
    setPaymentIssue(tx, {
      bookingId: row.bookingId,
      flag: null,
      clearOnly: "payout_failed",
      actor: "owner",
      reason: "payout_retry",
    }),
  );
  return sendPayout(ctx, next.id);
}

/**
 * UNCLAIMED → cancel first (SPEC §9.9.4), then the item comes back RETURNED and the row is failed.
 * An unknown cancel outcome leaves the row `cancelling`; the reconciler re-sends the same cancel.
 */
export async function cancelUnclaimed(ctx: PaymentContext, row: PayoutRow): Promise<PayoutRow> {
  const { db, paypal } = ctx;
  if (!row.paypalItemId) throw new PaymentStateError("The payout item isn't known yet.");
  const itemId = row.paypalItemId;
  const requestId = paypal.requestId("payout-cancel", itemId);
  try {
    await runOperation(db, {
      key: `payout-cancel:${row.id}`,
      kind: "payout-cancel",
      bookingId: row.bookingId,
      requestId,
      now: ctx.now,
      run: async () => {
        const item = await cancelUnclaimedItem(paypal, itemId, { requestId });
        return { status: item.transaction_status ?? null };
      },
    });
  } catch (error) {
    if (error instanceof OperationInProgressError) {
      await db.update(payouts).set({ status: "cancelling", updatedAt: ctx.now() }).where(eq(payouts.id, row.id));
      return getPayout(db, row.id);
    }
    // A definite refusal (e.g. the recipient claimed it meanwhile): just follow PayPal's state.
    if (!(error instanceof OperationFailedError) && !isDefiniteFailure(error)) throw error;
  }
  return syncPayout(ctx, row.id);
}

async function recognisedFor(db: Executor, row: PayoutRow): Promise<number> {
  if (row.source === "capture") {
    const [c] = await db.select().from(captures).where(eq(captures.id, row.sourceId));
    return c.amountCents;
  }
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, row.sourceId));
  return Math.min(inv.paidCents, inv.totalCents);
}

export async function getPayout(db: Executor, payoutId: string): Promise<PayoutRow> {
  const [row] = await db.select().from(payouts).where(eq(payouts.id, payoutId));
  if (!row) throw new PaymentStateError("Payout not found.", 404, "not_found");
  return row;
}

/** Pending payout rows whose technician has a payout email (the job sends these). */
export async function pendingPayoutIds(db: Executor, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: payouts.id })
    .from(payouts)
    .innerJoin(technicians, eq(technicians.id, payouts.technicianId))
    .where(and(eq(payouts.status, "pending"), eq(payouts.sample, false), sql`${technicians.payoutEmail} is not null`))
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function processingPayoutIds(db: Executor, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: payouts.id })
    .from(payouts)
    .where(and(inArray(payouts.status, ["processing", "cancelling", "unclaimed"]), eq(payouts.sample, false)))
    // Oldest sync first; every sync bumps updated_at, so long-lived UNCLAIMED rows can't starve the rest.
    .orderBy(payouts.updatedAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

/** For the env check in the lab and the dashboard. */
export function businessEmail(): string | undefined {
  return readVar(process.env, "PAYPAL_BUSINESS_EMAIL");
}
