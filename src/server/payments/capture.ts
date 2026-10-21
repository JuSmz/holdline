import { and, eq, ne } from "drizzle-orm";

import { authorizations, captures, invoices } from "@/db/schema";
import type { BookingStatus } from "@/server/domain/booking-state";
import { type Actor, type Booking, lockBooking, setPaymentIssue, transitionBooking } from "@/server/domain/transition";
import { payPalToCents } from "@/server/money";
import { alreadyDoneOutcome } from "@/server/paypal/errors";
import { getOrder } from "@/server/paypal/orders";
import {
  captureAuthorization,
  getAuthorization as getPayPalAuthorization,
  voidAuthorization,
} from "@/server/paypal/payments";

import { type PaymentContext, PaymentStateError } from "./context";
import {
  claimOperation,
  hasOperationInFlight,
  isDefiniteFailure,
  markOperationFailed,
  nextRetryKey,
  OperationFailedError,
  OperationInProgressError,
  runOperation,
} from "./ledger";
import { createPayoutRow } from "./payouts";
import { activeAuthorization, type AuthorizationRow, assertLive, chainRoot, getBooking } from "./queries";
import { voidHold } from "./void";

export type CaptureKind = "full" | "no_show_fee" | "late_cancel_fee";

/** The status a capture of each kind starts from (SPEC §8.2). */
const SOURCE: Record<CaptureKind, BookingStatus> = {
  full: "completed",
  no_show_fee: "no_show",
  late_cancel_fee: "cancelled",
};

export type MoneyOutcome = {
  status: "captured" | "capture_pending" | "capture_failed" | "processing" | "voided";
  booking: Booking;
};

/** What a capture operation stores as its ledger result; enough to re-apply it after a crash. */
export type CaptureInfo = {
  paypalCaptureId: string;
  status: string;
  amountCents: number;
  finalCapture: boolean;
  /** Our authorizations.id the capture was made on. */
  authorizationId: string;
};

/** Job done → full capture (SPEC §9.3). Allowed any time; a repeat resumes the capture. */
export async function markJobDone(
  ctx: PaymentContext,
  bookingId: string,
  actor: Actor = "owner",
): Promise<MoneyOutcome> {
  await ctx.db.transaction(async (tx) => {
    assertLive(await lockBooking(tx, bookingId));
    return transitionBooking(tx, { bookingId, from: "authorized", to: "completed", actor, reason: "job_done" });
  });
  return captureBooking(ctx, bookingId, "full");
}

/** No-show → fee capture with final_capture, rest released (SPEC §9.4). A zero fee releases the hold. */
export async function markNoShow(
  ctx: PaymentContext,
  bookingId: string,
  actor: Actor = "owner",
): Promise<MoneyOutcome> {
  const { booking } = await ctx.db.transaction(async (tx) => {
    assertLive(await lockBooking(tx, bookingId));
    return transitionBooking(tx, { bookingId, from: "authorized", to: "no_show", actor, reason: "no_show" });
  });
  if (booking.noShowFeeCents === 0) return voidHold(ctx, bookingId, "no_show", "no_fee");
  return captureBooking(ctx, bookingId, "no_show_fee");
}

/**
 * Retry capture after `capture_failed` (SPEC §8.3): a new ledger key; disabled once a fallback invoice
 * exists. The checks and the claim run under the booking lock, so a concurrent Bill via invoice can't
 * slip in between (it takes the same lock and refuses while a capture is in flight).
 */
export async function retryCapture(ctx: PaymentContext, bookingId: string): Promise<MoneyOutcome> {
  const { db, paypal } = ctx;
  const { kind, n } = await db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    assertLive(b);
    if (b.paymentIssue !== "capture_failed") throw new PaymentStateError("There is no failed capture to retry.");
    const k = (Object.keys(SOURCE) as CaptureKind[]).find((key) => SOURCE[key] === b.status);
    if (!k) throw new PaymentStateError("This capture can't be retried; bill via invoice instead.");
    const [fallback] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.bookingId, bookingId), eq(invoices.kind, "fallback"), ne(invoices.status, "cancelled")));
    if (fallback) {
      throw new PaymentStateError("A fallback invoice exists; Retry capture is disabled.", 409, "invoice_exists");
    }
    if (await hasOperationInFlight(tx, bookingId, "capture:")) {
      throw new PaymentStateError("A capture is still in progress.", 409, "in_progress");
    }
    const retry = await nextRetryKey(tx, `capture:${k}:${bookingId}`);
    await claimOperation(tx, {
      key: retry.key,
      kind: "capture",
      bookingId,
      requestId: captureRequestId(paypal, k, bookingId, retry.n),
      now: ctx.now(),
    });
    return { kind: k, n: retry.n };
  });
  return captureBooking(ctx, bookingId, kind, { resumeRetry: n, preclaimed: true });
}

const captureRequestId = (paypal: PaymentContext["paypal"], kind: CaptureKind, bookingId: string, n: number) =>
  paypal.requestId("capture", kind, bookingId, ...(n ? [`r${n}`] : []));

/**
 * The capture itself (SPEC §9.3–9.5), under the ledger key `capture:<kind>:<bookingId>`.
 * COMPLETED → captured + payout row in one transaction; PENDING → captured + capture_pending;
 * DECLINED/FAILED or a definite 422 → capture_failed. An unknown outcome reports "processing".
 */
export async function captureBooking(
  ctx: PaymentContext,
  bookingId: string,
  kind: CaptureKind,
  /**
   * resumeRetry: run (or resume) retry number n; preclaimed: retryCapture already claimed that key
   * under the booking lock.
   */
  options: { resumeRetry?: number; preclaimed?: boolean } = {},
): Promise<MoneyOutcome> {
  const { db, paypal } = ctx;
  const b = await getBooking(db, bookingId);
  assertLive(b);
  if (b.status !== SOURCE[kind]) {
    if (b.status === "captured" || b.status === "paid_out") return { status: "captured", booking: b };
    throw new PaymentStateError(`Can't capture from ${b.status}.`);
  }
  const auth = await activeAuthorization(db, b);
  const amountCents = kind === "full" ? b.priceCents : b.noShowFeeCents;
  const base = `capture:${kind}:${bookingId}`;
  const retry = options.resumeRetry
    ? { key: `${base}:retry-${options.resumeRetry}`, n: options.resumeRetry }
    : { key: base, n: 0 };
  const requestId = captureRequestId(paypal, kind, bookingId, retry.n);
  // Captures need a unique invoice_id per merchant: fees and retries get their own.
  const invoiceId = `${paypal.instanceId}-${b.ref}${kind === "full" ? "" : "-F"}${retry.n ? `-R${retry.n}` : ""}`;
  const find = () => findCapture(ctx, auth, invoiceId);
  // A failed lookup after "already captured" must never count as a definite failure.
  const lookUp = () =>
    find().catch((error: unknown) => {
      throw new Error(`capture lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    });

  let info: CaptureInfo;
  try {
    ({ result: info } = await runOperation<CaptureInfo>(db, {
      key: retry.key,
      kind: "capture",
      bookingId,
      requestId,
      now: ctx.now,
      preclaimed: options.preclaimed,
      probe: find,
      run: async () => {
        try {
          const capture = await captureAuthorization(paypal, auth.paypalAuthorizationId, {
            requestId,
            amountCents,
            currency: "USD",
            finalCapture: true,
            invoiceId,
            noteToPayer: kind === "full" ? `${b.serviceName} (${b.ref})` : `No-show fee (${b.ref})`,
          });
          return {
            paypalCaptureId: capture.id,
            status: capture.status,
            amountCents: payPalToCents(capture.amount.value),
            finalCapture: capture.final_capture ?? true,
            authorizationId: auth.id,
          };
        } catch (error) {
          if (alreadyDoneOutcome("capture", error) === "captured") {
            const existing = await lookUp();
            if (existing) return existing;
            throw new Error("PayPal says captured, but the capture can't be found yet");
          }
          throw error;
        }
      },
    }));
  } catch (error) {
    if (error instanceof OperationInProgressError)
      return { status: "processing", booking: await getBooking(db, bookingId) };
    // Any definite refusal (declined, AUTHORIZATION_EXPIRED/VOIDED/DENIED, …): flag it, never roll back.
    if (error instanceof OperationFailedError || isDefiniteFailure(error)) {
      const flagged = await ctx.db.transaction((tx) =>
        setPaymentIssue(tx, {
          bookingId,
          flag: "capture_failed",
          actor: "system",
          reason: "capture_failed",
          detail: { kind },
        }),
      );
      return { status: "capture_failed", booking: flagged.booking };
    }
    throw error;
  }
  const outcome = await applyCapture(ctx, bookingId, kind, auth, info);
  // PayPal answered, but the money didn't move: once capture_failed is committed, an owner retry may run
  // under a new key. (A crash in between is repaired by the reconciler, which does the same.)
  if (info.status === "DECLINED" || info.status === "FAILED") {
    await markOperationFailed(db, retry.key, `capture ${info.status}`);
  }
  return outcome;
}

/** Finds our capture on PayPal (GET order → payments.captures) by its invoice_id. */
async function findCapture(
  ctx: PaymentContext,
  auth: AuthorizationRow,
  invoiceId: string,
): Promise<CaptureInfo | null> {
  if (!auth.paypalOrderId) {
    const root = await chainRoot(ctx.db, auth);
    if (!root.paypalOrderId) return null;
    auth = { ...auth, paypalOrderId: root.paypalOrderId };
  }
  const order = await getOrder(ctx.paypal, auth.paypalOrderId!);
  const capture = order.purchase_units?.[0]?.payments?.captures?.find((c) => c.invoice_id === invoiceId);
  if (!capture) return null;
  return {
    paypalCaptureId: capture.id,
    status: capture.status,
    amountCents: payPalToCents(capture.amount.value),
    finalCapture: capture.final_capture ?? true,
    authorizationId: auth.id,
  };
}

/** Records the capture and moves the booking (idempotent: webhooks and recovery may call it again). */
export async function applyCapture(
  ctx: PaymentContext,
  bookingId: string,
  kind: CaptureKind,
  auth: AuthorizationRow,
  info: CaptureInfo,
): Promise<MoneyOutcome> {
  const { db, paypal } = ctx;
  const result = await db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    const [row] = await tx
      .insert(captures)
      .values({
        bookingId,
        authorizationId: auth.id,
        paypalCaptureId: info.paypalCaptureId,
        kind,
        amountCents: info.amountCents,
        finalCapture: info.finalCapture,
        status: info.status,
      })
      .onConflictDoUpdate({ target: captures.paypalCaptureId, set: { status: info.status, updatedAt: ctx.now() } })
      .returning();

    if (info.status === "COMPLETED" || info.status === "PENDING") {
      const pending = info.status === "PENDING";
      if (b.status === SOURCE[kind]) {
        const moved = await transitionBooking(tx, {
          bookingId,
          from: SOURCE[kind],
          to: "captured",
          actor: "system",
          reason: `capture_${kind}`,
          flag: pending ? "capture_pending" : null,
          detail: { paypalCaptureId: info.paypalCaptureId, amountCents: info.amountCents },
        });
        if (!pending) {
          await createPayoutRow(tx, {
            instanceId: paypal.instanceId,
            workspaceId: b.workspaceId,
            bookingId,
            technicianId: b.technicianId,
            source: "capture",
            sourceId: row.id,
            recognisedCents: info.amountCents,
          });
        }
        return { status: pending ? ("capture_pending" as const) : ("captured" as const), booking: moved.booking };
      }
      return { status: "captured" as const, booking: b };
    }

    // DECLINED / FAILED: the money did not move.
    if (b.status === SOURCE[kind]) {
      const flagged = await setPaymentIssue(tx, {
        bookingId,
        flag: "capture_failed",
        actor: "system",
        reason: `capture_${info.status.toLowerCase()}`,
      });
      return { status: "capture_failed" as const, booking: flagged.booking };
    }
    return { status: "capture_failed" as const, booking: b };
  });

  if (result.status === "captured" || result.status === "capture_pending") {
    await db
      .update(authorizations)
      .set({ status: "CAPTURED", updatedAt: ctx.now() })
      .where(eq(authorizations.id, auth.id));
    // A fee capture with final_capture should release the rest; if PayPal still holds it, void the parent.
    if (kind !== "full") await releaseRemainder(ctx, bookingId, auth);
  }
  return result;
}

async function releaseRemainder(ctx: PaymentContext, bookingId: string, auth: AuthorizationRow) {
  const fresh = await getPayPalAuthorization(ctx.paypal, auth.paypalAuthorizationId);
  if (fresh.status !== "PARTIALLY_CAPTURED" && fresh.status !== "CREATED") return;
  const root = await chainRoot(ctx.db, auth);
  const requestId = ctx.paypal.requestId("void", bookingId);
  await runOperation(ctx.db, {
    key: `void:${bookingId}`,
    kind: "void",
    bookingId,
    requestId,
    now: ctx.now,
    run: async () => {
      try {
        await voidAuthorization(ctx.paypal, root.paypalAuthorizationId, { requestId });
      } catch (error) {
        if (alreadyDoneOutcome("void", error) !== "voided") throw error;
      }
      return { voided: root.paypalAuthorizationId, remainder: true };
    },
  });
}
