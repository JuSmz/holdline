import { eq } from "drizzle-orm";

import { authorizations, bookings } from "@/db/schema";
import { honorUntil } from "@/server/domain/reauth";
import { lockBooking, logBookingEvent, setPaymentIssue } from "@/server/domain/transition";
import { payPalToCents } from "@/server/money";
import { getAuthorization as getPayPalAuthorization, reauthorizeAuthorization } from "@/server/paypal/payments";

import type { PaymentContext } from "./context";
import { DefiniteOperationError, OperationInProgressError, runOperation } from "./ledger";
import { activeAuthorization, assertLive, getBooking } from "./queries";

export type ReauthOutcome = "reauthorized" | "failed" | "processing" | "skipped";

/**
 * Reauthorization (SPEC §12, job 4): GET the parent, then POST …/reauthorize with request ID
 * `<instance>:reauth:<authId>`. The child becomes active for capture; voids still go to the parent.
 * One reauthorization per chain. A failure sets `reauth_failed` and the owner offers re-approval.
 */
export async function reauthorizeBooking(ctx: PaymentContext, bookingId: string): Promise<ReauthOutcome> {
  const { db, paypal } = ctx;
  const b = await getBooking(db, bookingId);
  assertLive(b);
  if (b.status !== "authorized" || b.paymentIssue) return "skipped";
  const parent = await activeAuthorization(db, b);
  if (parent.parentAuthorizationId) return "skipped"; // already the child of a chain
  if (!parent.reauthorizeAt || parent.reauthorizeAt > ctx.now()) return "skipped";

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
    const locked = await lockBooking(tx, bookingId);
    const [row] = await tx
      .insert(authorizations)
      .values({
        bookingId,
        paypalAuthorizationId: child.paypalAuthorizationId,
        parentAuthorizationId: parent.id,
        paypalOrderId: parent.paypalOrderId,
        status: child.status,
        amountCents: child.amountCents,
        honorUntil: honorUntil(child.createTime ? new Date(child.createTime) : ctx.now()),
        validUntil: child.expirationTime ? new Date(child.expirationTime) : parent.validUntil,
        role: "active",
      })
      .onConflictDoNothing({ target: authorizations.paypalAuthorizationId })
      .returning();
    if (row && locked.activeAuthorizationId === parent.id) {
      await tx
        .update(bookings)
        .set({ activeAuthorizationId: row.id, updatedAt: ctx.now() })
        .where(eq(bookings.id, bookingId));
      await tx.update(authorizations).set({ reauthorizeAt: null }).where(eq(authorizations.id, parent.id));
      await logBookingEvent(tx, {
        bookingId,
        actor: "system",
        flag: "reauthorized",
        detail: { parent: parent.paypalAuthorizationId, child: child.paypalAuthorizationId },
      });
    }
  });
  return "reauthorized";
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
