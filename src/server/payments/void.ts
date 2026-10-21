import { and, eq, inArray } from "drizzle-orm";

import { authorizations, captures } from "@/db/schema";
import { conflictMessage } from "@/server/domain/booking-state";
import { isLateCancellation, policyOf } from "@/server/domain/policy";
import { type Actor, lockBooking, transitionBooking } from "@/server/domain/transition";
import { alreadyDoneOutcome, PayPalApiError } from "@/server/paypal/errors";
import { voidAuthorization } from "@/server/paypal/payments";

import { captureBooking, type MoneyOutcome } from "./capture";
import { type PaymentContext, PaymentStateError } from "./context";
import { DefiniteOperationError, hasOperationInFlight, OperationInProgressError, runOperation } from "./ledger";
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
): Promise<MoneyOutcome> {
  const { db, paypal } = ctx;
  const b = await getBooking(db, bookingId);
  assertLive(b);
  if (b.status === "voided") return { status: "voided", booking: b };
  if (b.status !== from) throw new PaymentStateError(`Can't release the hold from ${b.status}.`);
  const auth = await activeAuthorization(db, b);
  const root = await chainRoot(db, auth);
  const requestId = paypal.requestId("void", bookingId);

  try {
    await runOperation(db, {
      key: `void:${bookingId}`,
      kind: "void",
      bookingId,
      requestId,
      now: ctx.now,
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
  const { db } = ctx;
  const b = await getBooking(db, bookingId);
  assertLive(b);
  const from = b.status === "no_show" ? "no_show" : b.status === "cancelled" ? "cancelled" : null;
  if (!from) {
    if (b.status === "voided") return { status: "voided", booking: b };
    throw new PaymentStateError("There is no fee to waive.");
  }
  if (await hasOperationInFlight(db, bookingId, "capture:")) {
    throw new PaymentStateError("A fee capture is still in progress.", 409, "in_progress");
  }
  const [captured] = await db
    .select({ id: captures.id })
    .from(captures)
    .where(and(eq(captures.bookingId, bookingId), inArray(captures.status, ["COMPLETED", "PENDING"])));
  if (captured) throw new PaymentStateError("The fee was already captured.");
  return voidHold(ctx, bookingId, from, "fee_waived", "owner");
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
): Promise<CancelOutcome> {
  const { db } = ctx;
  const now = ctx.now();
  const b = await getBooking(db, bookingId);
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

  const late = b.status === "cancelled" ? b.cancelReason === "late" : isLateCancellation(policy, b.slotStart, now);
  const fee = late ? b.noShowFeeCents : 0;
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
  } else if (b.status !== "cancelled") {
    throw new PaymentStateError(conflictMessage(b.status));
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
