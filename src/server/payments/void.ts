import { and, eq, inArray } from "drizzle-orm";

import { authorizations, captures, invoices } from "@/db/schema";
import { conflictMessage } from "@/server/domain/booking-state";
import { isLateCancellation, policyOf } from "@/server/domain/policy";
import { type Actor, type Booking, lockBooking, transitionBooking } from "@/server/domain/transition";
import { alreadyDoneOutcome, PayPalApiError } from "@/server/paypal/errors";
import { voidAuthorization } from "@/server/paypal/payments";

import { captureBooking, type MoneyOutcome } from "./capture";
import { type PaymentContext, PaymentStateError } from "./context";
import {
  claimOperation,
  DefiniteOperationError,
  hasOperationInFlight,
  OperationInProgressError,
  resumableKey,
  runOperation,
} from "./ledger";
import { activeAuthorization, assertLive, chainRoot, getBooking, getWorkspace } from "./queries";

/**
 * Releases the hold: void the chain's PARENT (SPEC §9.5), under `void:<bookingId>`, then
 * `from → voided`. PREVIOUSLY_VOIDED and an expired authorization both count as released.
 */
export async function voidHold(
  ctx: PaymentContext,
  bookingId: string,
  from: "cancelled" | "no_show",
  reason: string,
  actor: Actor = "system",
  /** A void key the caller already claimed under the booking lock (Waive fee). */
  claimed?: { key: string; n: number },
): Promise<MoneyOutcome> {
  const { db, paypal } = ctx;
  const b = await getBooking(db, bookingId);
  assertLive(b);
  if (b.status === "voided") return { status: "voided", booking: b };
  if (b.status !== from) throw new PaymentStateError(`Can't release the hold from ${b.status}.`);
  const auth = await activeAuthorization(db, b);
  const root = await chainRoot(db, auth);
  // After a definite failure an owner re-click (Cancel, Waive) retries under a new key.
  const attempt = claimed ?? (await resumableKey(db, `void:${bookingId}`));
  const requestId = paypal.requestId("void", bookingId, ...(attempt.n ? [`r${attempt.n}`] : []));

  try {
    await runOperation(db, {
      key: attempt.key,
      kind: "void",
      bookingId,
      requestId,
      now: ctx.now,
      preclaimed: Boolean(claimed),
      run: async () => {
        try {
          await voidAuthorization(paypal, root.paypalAuthorizationId, { requestId });
        } catch (error) {
          const done = alreadyDoneOutcome("void", error);
          if (done === "captured") throw new DefiniteOperationError("the hold was already captured");
          const expired = error instanceof PayPalApiError && /EXPIRED/.test(error.issue ?? "");
          if (done !== "voided" && !expired) throw error;
        }
        return { voided: root.paypalAuthorizationId };
      },
    });
  } catch (error) {
    if (error instanceof OperationInProgressError)
      return { status: "processing", booking: await getBooking(db, bookingId) };
    throw error;
  }

  const moved = await db.transaction(async (tx) => {
    await tx
      .update(authorizations)
      .set({ status: "VOIDED", updatedAt: ctx.now() })
      .where(inArray(authorizations.id, [root.id, auth.id]));
    return transitionBooking(tx, { bookingId, from, to: "voided", actor, reason, flag: null });
  });
  return { status: "voided", booking: moved.booking };
}

/** Waive fee (SPEC §9.4.5): no_show → voided; also clears a failed late fee (cancelled → voided). */
export async function waiveFee(ctx: PaymentContext, bookingId: string): Promise<MoneyOutcome> {
  const { db, paypal } = ctx;
  // Checks and the void claim under the booking lock: Bill via invoice takes the same lock and refuses
  // once this void is claimed; we refuse while its fallback invoice is open.
  const decision = await db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    assertLive(b);
    const from: "no_show" | "cancelled" | null =
      b.status === "no_show" ? "no_show" : b.status === "cancelled" ? "cancelled" : null;
    if (!from) {
      if (b.status === "voided") return { done: true as const, booking: b };
      throw new PaymentStateError("There is no fee to waive.");
    }
    if (await hasOperationInFlight(tx, bookingId, "capture:")) {
      throw new PaymentStateError("A fee capture is still in progress.", 409, "in_progress");
    }
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
    if (openInvoice) {
      throw new PaymentStateError("A fallback invoice is open; cancel it before waiving the fee.", 409, "invoice_open");
    }
    const [captured] = await tx
      .select({ id: captures.id })
      .from(captures)
      .where(and(eq(captures.bookingId, bookingId), inArray(captures.status, ["COMPLETED", "PENDING"])));
    if (captured) throw new PaymentStateError("The fee was already captured.");
    const attempt = await resumableKey(tx, `void:${bookingId}`);
    const claimed = await claimOperation(tx, {
      key: attempt.key,
      kind: "void",
      bookingId,
      requestId: paypal.requestId("void", bookingId, ...(attempt.n ? [`r${attempt.n}`] : [])),
      now: ctx.now(),
    });
    return { done: false as const, from, attempt, claimed };
  });
  if (decision.done) return { status: "voided", booking: decision.booking };
  // Only a key we just claimed runs directly; an existing attempt is waited for or replayed.
  return voidHold(
    ctx,
    bookingId,
    decision.from,
    "fee_waived",
    "owner",
    decision.claimed ? decision.attempt : undefined,
  );
}

export type CancelOutcome = MoneyOutcome & { rule: "withdrawn" | "free_void" | "late_fee"; amountCents: number };

/**
 * Owner cancellation (SPEC §9.5): before payment the booking just expires (`withdrawn`); after it, a
 * timely cancel voids the hold and a late one (< cancellation window) captures the fee.
 */
export async function cancelBooking(
  ctx: PaymentContext,
  bookingId: string,
  actor: Actor = "owner",
  /** The status the caller confirmed (e.g. the owner's dialog): anything else is a 409, never a silent fee. */
  expectStatus?: Booking["status"],
): Promise<CancelOutcome> {
  const { db } = ctx;
  const now = ctx.now();
  const b = await getBooking(db, bookingId);
  if (expectStatus && b.status !== expectStatus) {
    throw new PaymentStateError("The booking just changed. Check it and try again.", 409, "rule_changed");
  }
  assertLive(b);
  const policy = policyOf((await getWorkspace(db, b.workspaceId)).policy);

  if (b.status === "pending_payment" || b.status === "expired") {
    const { booking } = await db.transaction(async (tx) => {
      const locked = await lockBooking(tx, bookingId);
      if (locked.status === "pending_payment" && locked.authorizingUntil && locked.authorizingUntil > now) {
        throw new PaymentStateError("The customer is approving the payment right now.", 409, "authorizing");
      }
      return transitionBooking(tx, {
        bookingId,
        from: "pending_payment",
        to: "expired",
        actor,
        reason: "withdrawn",
        flag: null,
        patch: { cancelReason: "withdrawn" },
      });
    });
    return { status: "voided", booking, rule: "withdrawn", amountCents: 0 };
  }

  const decided = b.status !== "authorized";
  const late = decided ? b.cancelReason === "late" : isLateCancellation(policy, b.slotStart, now);
  const fee = late ? b.noShowFeeCents : 0;
  if (decided && b.status !== "cancelled") {
    // An exact repeat of a finished cancel returns its result (§8.4.2); anything else is a sibling (409).
    const { changed } = await db.transaction((tx) =>
      transitionBooking(tx, { bookingId, from: "authorized", to: "cancelled", actor, reason: "repeat" }),
    );
    if (!changed && (b.status === "voided" || b.status === "captured" || b.status === "paid_out")) {
      const rule = b.cancelReason === "late" ? ("late_fee" as const) : ("free_void" as const);
      return {
        status: b.status === "voided" ? "voided" : "captured",
        booking: b,
        rule,
        amountCents: rule === "late_fee" ? b.noShowFeeCents : 0,
      };
    }
    throw new PaymentStateError(conflictMessage(b.status));
  }
  if (b.status === "authorized") {
    await db.transaction((tx) =>
      transitionBooking(tx, {
        bookingId,
        from: "authorized",
        to: "cancelled",
        actor,
        reason: late ? "late" : "owner",
        patch: { cancelReason: late ? "late" : "owner" },
      }),
    );
  }

  if (fee > 0) {
    const outcome = await captureBooking(ctx, bookingId, "late_cancel_fee");
    return { ...outcome, rule: "late_fee", amountCents: fee };
  }
  const outcome = await voidHold(ctx, bookingId, "cancelled", "cancelled", actor);
  return { ...outcome, rule: "free_void", amountCents: 0 };
}

/** Stale hold (SPEC §12, job 5): authorized → cancelled (hold_timeout) → void → voided. */
export async function releaseStaleHold(ctx: PaymentContext, bookingId: string): Promise<MoneyOutcome> {
  await ctx.db.transaction((tx) =>
    transitionBooking(tx, {
      bookingId,
      from: "authorized",
      to: "cancelled",
      actor: "system",
      reason: "hold_timeout",
      patch: { cancelReason: "hold_timeout" },
    }),
  );
  return voidHold(ctx, bookingId, "cancelled", "hold_timeout");
}
