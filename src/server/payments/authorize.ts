import { and, eq, gt, sql } from "drizzle-orm";

import { authorizations, bookings, paymentOperations, paypalOrders } from "@/db/schema";
import { conflictMessage } from "@/server/domain/booking-state";
import { honorUntil, reauthorizeAt } from "@/server/domain/reauth";
import {
  type Actor,
  type Booking,
  lockBooking,
  logBookingEvent,
  setPaymentIssue,
  transitionBooking,
} from "@/server/domain/transition";
import { payPalToCents } from "@/server/money";
import { alreadyDoneOutcome, isDeclined, PayPalApiError } from "@/server/paypal/errors";
import { authorizeOrder, createAuthorizeOrder, firstAuthorization, getOrder } from "@/server/paypal/orders";
import { voidAuthorization } from "@/server/paypal/payments";
import type { Order } from "@/server/paypal/types";

import { type PaymentContext, PaymentStateError } from "./context";
import { DefiniteOperationError, OperationFailedError, OperationInProgressError, runOperation } from "./ledger";
import {
  type AuthorizationRow,
  assertLive,
  chainRoot,
  getBooking,
  getWorkspace,
  latestOrder,
  orderOf,
} from "./queries";

const MINUTE = 60_000;
/** An order created before the TTL may still be authorized this long after it (SPEC §9.2). */
const TTL_GRACE_MS = 10 * MINUTE;
const AUTHORIZING_MS = 2 * MINUTE;
/** PENDING (under review) authorizations keep the slot this much longer (SPEC §8.3). */
const PENDING_HOLD_MS = 6 * 60 * MINUTE;
const REUSABLE_ORDER = new Set(["CREATED", "PAYER_ACTION_REQUIRED", "APPROVED"]);
/** PayPal expires unapproved orders; an older one is replaced by a new attempt. */
const ORDER_REUSE_MS = 3 * 60 * MINUTE;

export type PayStatus = "authorized" | "processing" | "declined_retry" | "expired";
export type AuthorizeOutcome = { status: PayStatus; booking: Booking };

function isReapproval(b: Booking): boolean {
  return b.status === "authorized" && (b.paymentIssue === "reauth_failed" || b.paymentIssue === "hold_lost");
}

/**
 * createOrder (SPEC §9.2): the amount is the booking's snapshot, never client input. An open order for
 * the same amount is reused; otherwise a new attempt gets its own deterministic request ID.
 */
export async function createOrderForBooking(ctx: PaymentContext, bookingId: string): Promise<{ orderId: string }> {
  const { db, paypal } = ctx;
  const booking = await getBooking(db, bookingId);
  assertLive(booking);
  if (!isReapproval(booking)) {
    if (booking.status === "expired") {
      throw new PaymentStateError("The payment window for this booking has closed.", 410, "expired");
    }
    if (booking.status !== "pending_payment") throw new PaymentStateError(conflictMessage(booking.status));
    if (booking.holdExpiresAt.getTime() <= ctx.now().getTime()) {
      throw new PaymentStateError("The payment window for this booking has closed.", 410, "expired");
    }
    if (booking.paymentIssue === "authorization_pending") {
      throw new PaymentStateError("PayPal is still reviewing the last payment.", 409, "processing");
    }
  }

  const last = await latestOrder(db, bookingId);
  const fresh = last && ctx.now().getTime() - last.createdAt.getTime() < ORDER_REUSE_MS;
  if (last && fresh && last.amountCents === booking.priceCents && REUSABLE_ORDER.has(last.status)) {
    return { orderId: last.paypalOrderId };
  }
  // Resume an open create; never reuse an attempt number whose create failed (SPEC §10.3).
  const ops = await db
    .select({ key: paymentOperations.key, state: paymentOperations.state })
    .from(paymentOperations)
    .where(sql`${paymentOperations.key} like ${`order-create:${bookingId}:%`}`);
  const attemptOf = (key: string) => Number(key.split(":")[2]);
  const open = ops.find((o) => o.state === "in_flight");
  const attempt = open ? attemptOf(open.key) : Math.max(last?.attempt ?? 0, ...ops.map((o) => attemptOf(o.key))) + 1;
  const workspace = await getWorkspace(db, booking.workspaceId);
  const requestId = paypal.requestId("order-create", bookingId, String(attempt));

  const { result } = await runOperation(db, {
    key: `order-create:${bookingId}:${attempt}`,
    kind: "order-create",
    bookingId,
    requestId,
    now: ctx.now,
    run: async () => {
      const order = await createAuthorizeOrder(paypal, {
        requestId,
        amountCents: booking.priceCents,
        currency: "USD",
        customId: bookingId,
        invoiceId: `${paypal.instanceId}-${booking.ref}-${attempt}`,
        description: `Holdline hold – ${booking.serviceName}`.slice(0, 127),
        brandName: workspace.name.slice(0, 127),
      });
      await db
        .insert(paypalOrders)
        .values({ bookingId, paypalOrderId: order.id, attempt, status: order.status, amountCents: booking.priceCents })
        .onConflictDoNothing();
      return { orderId: order.id };
    },
  });
  return result;
}

export type AuthInfo = {
  paypalAuthorizationId: string;
  status: string;
  amountCents: number;
  createTime: string | null;
  expirationTime: string | null;
};

function authInfo(order: Order): AuthInfo | null {
  const auth = firstAuthorization(order);
  if (!auth) return null;
  return {
    paypalAuthorizationId: auth.id,
    status: auth.status,
    amountCents: payPalToCents(auth.amount.value),
    createTime: auth.create_time ?? null,
    expirationTime: auth.expiration_time ?? null,
  };
}

/**
 * authorizeBooking (SPEC §9.2): called from onApprove, the CHECKOUT.ORDER.APPROVED webhook and the
 * reconciler, always under the ledger key `authorize:<orderId>`.
 */
export async function authorizeBooking(
  ctx: PaymentContext,
  bookingId: string,
  orderId: string,
  actor: Actor = "customer",
): Promise<AuthorizeOutcome> {
  const { db, paypal } = ctx;
  const order = await orderOf(db, bookingId, orderId);
  if (!order) throw new PaymentStateError("This PayPal order doesn't belong to the booking.", 404, "unknown_order");

  // 1. A short transaction claims the booking; the PayPal call happens outside the lock.
  const claim = await db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    assertLive(b);
    const now = ctx.now();
    if (b.status === "pending_payment") {
      const late = now.getTime() > b.holdExpiresAt.getTime();
      const inGrace =
        order.createdAt.getTime() <= b.holdExpiresAt.getTime() &&
        now.getTime() <= b.holdExpiresAt.getTime() + TTL_GRACE_MS;
      if (late && !inGrace) {
        // A worker that claimed in time and is still running keeps its claim; only a crashed one
        // (lease expired) is settled after the TTL by expiring the booking and voiding any hold (§24 #10).
        const [running] = await tx
          .select({ key: paymentOperations.key })
          .from(paymentOperations)
          .where(
            and(
              eq(paymentOperations.key, `authorize:${orderId}`),
              eq(paymentOperations.state, "in_flight"),
              gt(paymentOperations.leaseUntil, now),
            ),
          );
        return { ok: false as const, booking: b, busy: Boolean(running) };
      }
      await tx
        .update(bookings)
        .set({ authorizingUntil: new Date(now.getTime() + AUTHORIZING_MS), updatedAt: now })
        .where(eq(bookings.id, bookingId));
      return { ok: true as const, booking: b };
    }
    return { ok: isReapproval(b), booking: b };
  });

  const key = `authorize:${orderId}`;
  const requestId = paypal.requestId("order-authorize", orderId);
  const probe = async () => authInfo(await getOrder(paypal, orderId));

  if (!claim.ok && "busy" in claim && claim.busy) {
    return { status: "processing", booking: claim.booking };
  }
  if (!claim.ok) {
    // Too late or already moved on. Never authorize now. A booking past TTL + grace expires first, so a
    // hold that may already exist (crash after authorize) is settled as an orphan, never as a booking.
    if (claim.booking.status === "pending_payment") {
      await db.transaction((tx) =>
        transitionBooking(tx, {
          bookingId,
          from: "pending_payment",
          to: "expired",
          actor: "system",
          reason: "ttl",
          flag: null,
          patch: { cancelReason: "ttl", authorizingUntil: null },
        }),
      );
      ctx.notify(bookingId, "expired");
    }
    const existing = await probeOnly(ctx, key, probe);
    if (existing) return applyAuthorization(ctx, bookingId, orderId, existing, actor);
    const b = claim.booking;
    if (b.status === "authorized") return { status: "authorized", booking: b };
    return { status: b.status === "pending_payment" ? "expired" : statusFor(b), booking: b };
  }

  let info: AuthInfo;
  try {
    ({ result: info } = await runOperation<AuthInfo>(db, {
      key,
      kind: "authorize",
      bookingId,
      requestId,
      now: ctx.now,
      probe,
      run: async () => {
        try {
          const authorized = authInfo(await authorizeOrder(paypal, orderId, { requestId }));
          if (!authorized) throw new Error("PayPal returned no authorization");
          return authorized;
        } catch (error) {
          if (alreadyDoneOutcome("authorize", error) === "authorized") {
            // A failed lookup here must stay an unknown outcome, never a decline.
            const existing = await probe().catch((lookup: unknown) => {
              throw new Error(
                `authorization lookup failed: ${lookup instanceof Error ? lookup.message : String(lookup)}`,
              );
            });
            if (existing) return existing;
            throw new Error("PayPal says authorized, but the authorization can't be found yet");
          }
          throw error;
        }
      },
    }));
  } catch (error) {
    if (error instanceof OperationInProgressError) {
      return { status: "processing", booking: await getBooking(db, bookingId) };
    }
    if (isDeclined(error) || isPayPal422(error) || error instanceof OperationFailedError) {
      return declined(ctx, bookingId, orderId);
    }
    throw error;
  }
  return applyAuthorization(ctx, bookingId, orderId, info, actor);
}

const isPayPal422 = (error: unknown) => error instanceof PayPalApiError && error.status === 422;

function statusFor(b: Booking): PayStatus {
  if (b.status === "pending_payment")
    return b.paymentIssue === "authorization_pending" ? "processing" : "declined_retry";
  if (b.status === "expired") return "expired";
  // Still flagged after a re-approval attempt: the new hold didn't take (SPEC §9.8).
  if (isReapproval(b)) return "declined_retry";
  return "authorized";
}

/** Recovery without a new PayPal call: settle the ledger row from a GET, if there is one. */
async function probeOnly(
  ctx: PaymentContext,
  key: string,
  probe: () => Promise<AuthInfo | null>,
): Promise<AuthInfo | null> {
  const { db } = ctx;
  const [row] = await db.execute<{ state: string; result: AuthInfo | null }>(
    sql`select state, result from payment_operations where key = ${key}`,
  );
  if (!row) return null;
  if (row.state === "succeeded") return row.result;
  if (row.state === "failed") return null;
  const found = await probe();
  if (found) {
    await db.execute(
      sql`update payment_operations set state = 'succeeded', result = ${JSON.stringify(found)}::jsonb, updated_at = now() where key = ${key}`,
    );
  }
  return found;
}

async function declined(ctx: PaymentContext, bookingId: string, orderId: string): Promise<AuthorizeOutcome> {
  const { db } = ctx;
  await db
    .update(paypalOrders)
    .set({ status: "DECLINED", updatedAt: ctx.now() })
    .where(eq(paypalOrders.paypalOrderId, orderId));
  const [b] = await db
    .update(bookings)
    .set({ authorizingUntil: null, updatedAt: ctx.now() })
    .where(eq(bookings.id, bookingId))
    .returning();
  if (b.status === "pending_payment") ctx.notify(bookingId, "declined_retry");
  const retryable = b.status === "pending_payment" || isReapproval(b);
  return { status: retryable ? "declined_retry" : statusFor(b), booking: b };
}

/**
 * Applies an authorization PayPal reports (SPEC §9.2 step 3). Idempotent: onApprove, webhook and
 * reconciler may all call it. A CREATED hold the booking can't use becomes an orphan and is voided.
 */
export async function applyAuthorization(
  ctx: PaymentContext,
  bookingId: string,
  orderId: string,
  info: AuthInfo,
  actor: Actor,
): Promise<AuthorizeOutcome> {
  const { db } = ctx;
  const now = ctx.now();
  const outcome = await db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    const created = info.createTime ? new Date(info.createTime) : now;
    const [stored] = await tx
      .insert(authorizations)
      .values({
        bookingId,
        paypalAuthorizationId: info.paypalAuthorizationId,
        paypalOrderId: orderId,
        status: info.status,
        amountCents: info.amountCents,
        honorUntil: honorUntil(created),
        validUntil: info.expirationTime ? new Date(info.expirationTime) : null,
        role: "active",
      })
      .onConflictDoUpdate({
        target: authorizations.paypalAuthorizationId,
        set: { status: info.status, updatedAt: now },
      })
      .returning();
    await tx
      .update(paypalOrders)
      .set({ status: info.status === "DENIED" ? "DENIED" : "COMPLETED", updatedAt: now })
      .where(eq(paypalOrders.paypalOrderId, orderId));

    if (info.status === "DENIED") {
      await tx.update(bookings).set({ authorizingUntil: null, updatedAt: now }).where(eq(bookings.id, bookingId));
      return { kind: "declined" as const, booking: b };
    }

    if (info.status === "PENDING") {
      // A re-approval under review stays stored (not active yet); the poll applies it once it settles.
      if (isReapproval(b)) return { kind: "pending" as const, booking: b };
      if (b.status !== "pending_payment") return { kind: "orphan" as const, booking: b, auth: stored };
      await tx
        .update(bookings)
        .set({
          authorizingUntil: null,
          holdExpiresAt: new Date(Math.max(b.holdExpiresAt.getTime(), now.getTime() + PENDING_HOLD_MS)),
          updatedAt: now,
        })
        .where(eq(bookings.id, bookingId));
      const flagged = await setPaymentIssue(tx, {
        bookingId,
        flag: "authorization_pending",
        expect: ["pending_payment"],
        actor,
        reason: "authorization_pending",
      });
      return { kind: "pending" as const, booking: flagged.booking };
    }

    if (info.status !== "CREATED") return { kind: "other" as const, booking: b };

    if (b.activeAuthorizationId === stored.id) return { kind: "authorized" as const, booking: b, fresh: false };

    if (info.amountCents !== b.priceCents) {
      await tx.update(authorizations).set({ role: "orphan" }).where(eq(authorizations.id, stored.id));
      return { kind: "mismatch" as const, booking: b, auth: stored };
    }

    if (b.status === "pending_payment") {
      const moved = await transitionBooking(tx, {
        bookingId,
        from: "pending_payment",
        to: "authorized",
        actor,
        reason: "authorization_created",
        flag: null,
        detail: { paypalAuthorizationId: info.paypalAuthorizationId },
        patch: { activeAuthorizationId: stored.id, authorizedAt: now, authorizingUntil: null },
      });
      const at = reauthorizeAt({
        authorizedAt: now,
        honorUntil: stored.honorUntil ?? honorUntil(created),
        slotEnd: b.slotEnd,
      });
      await tx.update(authorizations).set({ reauthorizeAt: at }).where(eq(authorizations.id, stored.id));
      return { kind: "authorized" as const, booking: moved.booking, fresh: true };
    }

    if (isReapproval(b)) {
      // Re-approval (SPEC §9.8): the new hold becomes active, the old chain is voided, no status change.
      const replaced = b.activeAuthorizationId;
      await tx
        .update(bookings)
        .set({ activeAuthorizationId: stored.id, updatedAt: now })
        .where(eq(bookings.id, bookingId));
      if (replaced) await tx.update(authorizations).set({ role: "replaced" }).where(eq(authorizations.id, replaced));
      const at = reauthorizeAt({
        authorizedAt: now,
        honorUntil: stored.honorUntil ?? honorUntil(created),
        slotEnd: b.slotEnd,
      });
      await tx.update(authorizations).set({ reauthorizeAt: at }).where(eq(authorizations.id, stored.id));
      const cleared = await setPaymentIssue(tx, { bookingId, flag: null, actor, reason: "reapproved" });
      return { kind: "reapproved" as const, booking: cleared.booking, replaced };
    }

    // Part of the booking's live chain (e.g. the parent of a reauthorized child): nothing to do.
    if (b.activeAuthorizationId) {
      const [active] = await tx.select().from(authorizations).where(eq(authorizations.id, b.activeAuthorizationId));
      if (active?.parentAuthorizationId === stored.id) return { kind: "other" as const, booking: b };
    }
    // The booking moved on (TTL, supersede, already authorized by another order): the hold is an orphan.
    await tx.update(authorizations).set({ role: "orphan" }).where(eq(authorizations.id, stored.id));
    return { kind: "orphan" as const, booking: b, auth: stored };
  });

  switch (outcome.kind) {
    case "authorized":
      if (outcome.fresh) ctx.notify(bookingId, "authorized");
      return { status: "authorized", booking: outcome.booking };
    case "reapproved":
      if (outcome.replaced) await voidReplaced(ctx, bookingId, outcome.replaced);
      return { status: "authorized", booking: await getBooking(db, bookingId) };
    case "pending":
      return { status: "processing", booking: outcome.booking };
    case "declined":
      return declined(ctx, bookingId, orderId);
    case "mismatch":
      await voidOrphan(ctx, outcome.auth, "amount_mismatch");
      console.error(`[holdline] ALERT authorization amount mismatch on booking ${bookingId}; voided`);
      throw new PaymentStateError(
        "PayPal authorized a different amount; the hold was released.",
        409,
        "amount_mismatch",
      );
    case "orphan":
      await voidOrphan(ctx, outcome.auth, "booking_moved_on");
      return { status: statusFor(await getBooking(db, bookingId)), booking: await getBooking(db, bookingId) };
    default:
      return { status: statusFor(outcome.booking), booking: outcome.booking };
  }
}

/** Compensating void of a hold the booking doesn't use (SPEC §9.10). No status change; logged. */
export async function voidOrphan(ctx: PaymentContext, auth: AuthorizationRow, reason: string): Promise<void> {
  const { db, paypal } = ctx;
  const root = await chainRoot(db, auth);
  const requestId = paypal.requestId("void-orphan", root.paypalAuthorizationId);
  try {
    await runOperation(db, {
      key: `void-orphan:${root.paypalAuthorizationId}`,
      kind: "void-orphan",
      bookingId: auth.bookingId,
      requestId,
      now: ctx.now,
      run: async () => {
        try {
          await voidAuthorization(paypal, root.paypalAuthorizationId, { requestId });
        } catch (error) {
          const done = alreadyDoneOutcome("void", error);
          if (done === "captured") throw new DefiniteOperationError("orphan hold was already captured");
          if (done !== "voided") throw error;
        }
        return { voided: root.paypalAuthorizationId };
      },
    });
  } catch (error) {
    if (error instanceof OperationInProgressError) return; // the reconciler finishes it
    throw error;
  }
  await db
    .update(authorizations)
    .set({ status: "VOIDED", role: "orphan", updatedAt: ctx.now() })
    .where(eq(authorizations.id, auth.id));
  if (root.id !== auth.id) {
    await db
      .update(authorizations)
      .set({ status: "VOIDED", updatedAt: ctx.now() })
      .where(eq(authorizations.id, root.id));
  }
  await logBookingEvent(db, {
    bookingId: auth.bookingId,
    actor: "system",
    flag: "orphan_void",
    reason,
    detail: { paypalAuthorizationId: auth.paypalAuthorizationId },
  });
}

/** Re-approval: void the replaced chain through the ledger (SPEC §9.8). */
async function voidReplaced(ctx: PaymentContext, bookingId: string, replacedId: string): Promise<void> {
  const { db, paypal } = ctx;
  const [replaced] = await db.select().from(authorizations).where(eq(authorizations.id, replacedId));
  if (!replaced) return;
  const root = await chainRoot(db, replaced);
  const requestId = paypal.requestId("void-replaced", root.paypalAuthorizationId);
  try {
    await runOperation(db, {
      key: `void-replaced:${root.paypalAuthorizationId}`,
      kind: "void-replaced",
      bookingId,
      requestId,
      now: ctx.now,
      run: async () => {
        try {
          await voidAuthorization(paypal, root.paypalAuthorizationId, { requestId });
        } catch (error) {
          // A lost or failed hold is often already voided or expired: both are fine here.
          const done = alreadyDoneOutcome("void", error);
          const gone = error instanceof PayPalApiError && /EXPIRED|VOIDED/.test(error.issue ?? "");
          if (done !== "voided" && !gone) throw error;
        }
        return { voided: root.paypalAuthorizationId };
      },
    });
  } catch (error) {
    if (error instanceof OperationInProgressError) return;
    throw error;
  }
  await db
    .update(authorizations)
    .set({ status: "VOIDED", updatedAt: ctx.now() })
    .where(sql`${authorizations.id} in (${root.id}, ${replaced.id})`);
}
