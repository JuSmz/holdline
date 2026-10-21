import { and, eq, inArray } from "drizzle-orm";

import { authorizations, bookings, captures, paymentOperations } from "@/db/schema";
import { honorUntil } from "@/server/domain/reauth";
import { lockBooking, logBookingEvent, setPaymentIssue } from "@/server/domain/transition";
import { payPalToCents } from "@/server/money";
import { getAuthorization as getPayPalAuthorization, reauthorizeAuthorization } from "@/server/paypal/payments";

import type { Tx } from "@/db/types";

import type { PaymentContext } from "./context";
import { DefiniteOperationError, OperationInProgressError, runOperation } from "./ledger";
import { activeAuthorization, type AuthorizationRow, assertLive, getBooking } from "./queries";

export type ReauthOutcome = "reauthorized" | "failed" | "processing" | "skipped";

/**
 * Reauthorization (SPEC §12, job 4): GET the parent, then POST …/reauthorize with request ID
 * `<instance>:reauth:<authId>`. The child becomes active for capture; voids still go to the parent.
 * One reauthorization per chain. A failure sets `reauth_failed` and the owner offers re-approval.
 */
export async function reauthorizeBooking(
  ctx: PaymentContext,
  bookingId: string,
  /** resume: the reconciler finishes an in-flight reauthorization even if the booking moved on meanwhile. */
  options: { resume?: boolean } = {},
): Promise<ReauthOutcome> {
  const { db, paypal } = ctx;
  const b = await getBooking(db, bookingId);
  assertLive(b);
  if (!options.resume && (b.status !== "authorized" || b.paymentIssue)) return "skipped";
  if (!b.activeAuthorizationId) return "skipped";
  const active = await activeAuthorization(db, b);
  if (active.parentAuthorizationId) {
    // Already linked (possibly by the child's own webhook): settle a reauth row still left in flight.
    const [root] = await db.select().from(authorizations).where(eq(authorizations.id, active.parentAuthorizationId));
    if (root) {
      await db
        .update(paymentOperations)
        .set({
          state: "succeeded",
          result: {
            paypalAuthorizationId: active.paypalAuthorizationId,
            status: active.status,
            amountCents: active.amountCents,
            createTime: null,
            expirationTime: null,
          },
          appliedAt: ctx.now(),
          updatedAt: ctx.now(),
        })
        .where(
          and(
            eq(paymentOperations.key, `reauth:${root.paypalAuthorizationId}`),
            eq(paymentOperations.state, "in_flight"),
          ),
        );
    }
    return "skipped";
  }
  const parent = active;
  if (!options.resume && (!parent.reauthorizeAt || parent.reauthorizeAt > ctx.now())) return "skipped";

  const requestId = paypal.requestId("reauth", parent.paypalAuthorizationId);
  let child: {
    paypalAuthorizationId: string;
    status: string;
    amountCents: number;
    createTime: string | null;
    expirationTime: string | null;
  };
  try {
    ({ result: child } = await runOperation(db, {
      key: `reauth:${parent.paypalAuthorizationId}`,
      kind: "reauth",
      bookingId,
      requestId,
      now: ctx.now,
      run: async () => {
        const current = await getPayPalAuthorization(paypal, parent.paypalAuthorizationId);
        if (current.status !== "CREATED") throw new DefiniteOperationError(`parent is ${current.status}`);
        const created = await reauthorizeAuthorization(paypal, parent.paypalAuthorizationId, {
          requestId,
          amountCents: b.priceCents,
          currency: "USD",
        });
        return {
          paypalAuthorizationId: created.id,
          status: created.status,
          amountCents: payPalToCents(created.amount.value),
          createTime: created.create_time ?? null,
          expirationTime: created.expiration_time ?? null,
        };
      },
    }));
  } catch (error) {
    if (error instanceof OperationInProgressError) return "processing";
    await markReauthFailed(ctx, bookingId, error);
    return "failed";
  }

  if (child.status !== "CREATED" || child.amountCents !== b.priceCents) {
    await markReauthFailed(ctx, bookingId, new Error(`child ${child.status} ${child.amountCents}`));
    return "failed";
  }
  await db.transaction(async (tx) => {
    await linkReauthorizedChild(tx, {
      bookingId,
      parent,
      child: { ...child, validUntil: child.expirationTime ? new Date(child.expirationTime) : parent.validUntil },
      now: ctx.now(),
    });
  });
  return "reauthorized";
}

/**
 * Records a reauthorized child and makes it the capture target (SPEC §12). Idempotent and order-proof:
 * the AUTHORIZATION.CREATED webhook may get here before the reauthorize response is recorded.
 */
export async function linkReauthorizedChild(
  tx: Tx,
  input: {
    bookingId: string;
    parent: AuthorizationRow;
    child: {
      paypalAuthorizationId: string;
      status: string;
      amountCents: number;
      createTime: string | null;
      validUntil: Date | null;
    };
    now: Date;
  },
): Promise<void> {
  const locked = await lockBooking(tx, input.bookingId);
  const values = {
    bookingId: input.bookingId,
    paypalAuthorizationId: input.child.paypalAuthorizationId,
    parentAuthorizationId: input.parent.id,
    paypalOrderId: input.parent.paypalOrderId,
    status: input.child.status,
    amountCents: input.child.amountCents,
    honorUntil: honorUntil(input.child.createTime ? new Date(input.child.createTime) : input.now),
    validUntil: input.child.validUntil,
    role: "active" as const,
  };
  const [row] = await tx
    .insert(authorizations)
    .values(values)
    // An existing row keeps its own status and role (it may be captured or voided by now); only the link is set.
    .onConflictDoUpdate({
      target: authorizations.paypalAuthorizationId,
      set: { parentAuthorizationId: input.parent.id, updatedAt: input.now },
    })
    .returning();
  // Switch the capture target while the parent is still it and no money was captured (a Job done may
  // have raced the reauthorization; its retry must go to the child).
  const [captured] = await tx
    .select({ id: captures.id })
    .from(captures)
    .where(and(eq(captures.bookingId, input.bookingId), inArray(captures.status, ["COMPLETED", "PENDING"])));
  const switchable = ["authorized", "completed", "no_show", "cancelled"].includes(locked.status);
  if (switchable && !captured && locked.activeAuthorizationId === input.parent.id) {
    await tx
      .update(bookings)
      .set({ activeAuthorizationId: row.id, updatedAt: input.now })
      .where(eq(bookings.id, input.bookingId));
    await tx.update(authorizations).set({ reauthorizeAt: null }).where(eq(authorizations.id, input.parent.id));
    await logBookingEvent(tx, {
      bookingId: input.bookingId,
      actor: "system",
      flag: "reauthorized",
      detail: { parent: input.parent.paypalAuthorizationId, child: input.child.paypalAuthorizationId },
    });
  }
}

async function markReauthFailed(ctx: PaymentContext, bookingId: string, error: unknown) {
  await ctx.db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    if (b.status !== "authorized") return;
    await setPaymentIssue(tx, {
      bookingId,
      flag: "reauth_failed",
      actor: "system",
      reason: "reauth_failed",
      detail: { error: error instanceof Error ? error.message.slice(0, 200) : String(error) },
    });
  });
  console.error(`[holdline] ALERT reauthorization failed for booking ${bookingId}; re-approval needed`);
}
