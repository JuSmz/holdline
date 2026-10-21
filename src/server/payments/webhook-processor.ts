import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { authorizations, captures, invoices, paypalOrders, payouts, webhookEvents } from "@/db/schema";
import { dbErrorCode } from "@/server/db-error";
import { lockBooking, logBookingEvent, setPaymentIssue } from "@/server/domain/transition";
import { payPalToCents } from "@/server/money";
import { getAuthorization as getPayPalAuthorization, getCapture } from "@/server/paypal/payments";
import { type PayPalEvent, eventResourceId } from "@/server/paypal/webhook-events";

import { applyAuthorization, authorizeBooking } from "./authorize";
import { applyCapture, type CaptureKind } from "./capture";
import { processCaptureStatus } from "./capture-status";
import type { PaymentContext } from "./context";
import { syncPayout } from "./payouts";
import { getAuthorization } from "./queries";
import { syncInvoice } from "./invoices";

export type WebhookEventRow = typeof webhookEvents.$inferSelect;

/**
 * Processes one stored, verified event (SPEC §11.4): re-GET the resource — the payload is never trusted
 * for state — and map it onto the same CAS and ledger functions. Out-of-order delivery is harmless.
 * The event row is locked (SKIP LOCKED) for the duration, so concurrent duplicates are processed once.
 * Returns false when another worker holds it or it was already processed.
 */
export async function processWebhookEvent(ctx: PaymentContext, eventId: string): Promise<boolean> {
  const outcome = await ctx.db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, eventId))
      .for("update", { skipLocked: true });
    if (!event || event.processedAt) return { done: false as const };
    if (event.simulated) {
      // Lab simulator events are never processed (PLAN stage 6).
      await tx
        .update(webhookEvents)
        .set({ processedAt: ctx.now(), error: "simulated" })
        .where(eq(webhookEvents.id, eventId));
      return { done: true as const };
    }
    try {
      await handle(ctx, event);
    } catch (error) {
      // Committed with the lock released; PayPal's retry or the reconciler drives it again.
      await tx
        .update(webhookEvents)
        .set({ attempts: sql`${webhookEvents.attempts} + 1`, error: dbErrorCode(error).slice(0, 200) })
        .where(eq(webhookEvents.id, eventId));
      return { done: false as const, error };
    }
    await tx
      .update(webhookEvents)
      .set({ processedAt: ctx.now(), attempts: sql`${webhookEvents.attempts} + 1`, error: null })
      .where(eq(webhookEvents.id, eventId));
    return { done: true as const };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.done;
}

async function handle(ctx: PaymentContext, event: WebhookEventRow): Promise<void> {
  const { db, paypal } = ctx;
  const resourceId = event.resourceId ?? eventResourceId(event.raw as PayPalEvent);
  if (!resourceId) return;
  const type = event.eventType;

  if (type === "CHECKOUT.ORDER.APPROVED") {
    // Tab closed after approval: the webhook authorizes through the same ledger key (SPEC §9.2.6).
    const [order] = await db.select().from(paypalOrders).where(eq(paypalOrders.paypalOrderId, resourceId));
    if (order) await authorizeBooking(ctx, order.bookingId, order.paypalOrderId, "webhook");
    return;
  }

  if (type === "PAYMENT.AUTHORIZATION.CREATED" || type === "PAYMENT.AUTHORIZATION.VOIDED") {
    const remote = await getPayPalAuthorization(paypal, resourceId);
    const [stored] = await db.select().from(authorizations).where(eq(authorizations.paypalAuthorizationId, resourceId));
    const orderId = remote.supplementary_data?.related_ids?.order_id ?? stored?.paypalOrderId ?? null;
    const bookingId = stored?.bookingId ?? remote.custom_id ?? null;
    if (!bookingId) return;

    if (type === "PAYMENT.AUTHORIZATION.CREATED" && orderId) {
      const [order] = await db.select().from(paypalOrders).where(eq(paypalOrders.paypalOrderId, orderId));
      if (!order) return;
      await applyAuthorization(
        ctx,
        order.bookingId,
        orderId,
        {
          paypalAuthorizationId: remote.id,
          status: remote.status,
          amountCents: payPalToCents(remote.amount.value),
          createTime: remote.create_time ?? null,
          expirationTime: remote.expiration_time ?? null,
        },
        "webhook",
      );
      return;
    }

    if (type === "PAYMENT.AUTHORIZATION.VOIDED" && stored && remote.status === "VOIDED") {
      await db
        .update(authorizations)
        .set({ status: "VOIDED", updatedAt: ctx.now() })
        .where(eq(authorizations.id, stored.id));
      await db.transaction(async (tx) => {
        const b = await lockBooking(tx, stored.bookingId);
        const voidTarget =
          b.activeAuthorizationId === stored.id || (await isChainOf(tx, b.activeAuthorizationId, stored.id));
        // We void only after leaving `authorized`; a void while still authorized wasn't ours (SPEC §8.3).
        if (b.status === "authorized" && voidTarget && b.paymentIssue === null) {
          await setPaymentIssue(tx, {
            bookingId: b.id,
            flag: "hold_lost",
            actor: "webhook",
            reason: "authorization_voided",
          });
        }
      });
    }
    return;
  }

  if (type.startsWith("PAYMENT.CAPTURE.")) {
    const remote = await getCapture(paypal, resourceId);
    const [stored] = await db.select().from(captures).where(eq(captures.paypalCaptureId, resourceId));
    if (!stored) return; // our in-flight capture's recovery records it
    if (type === "PAYMENT.CAPTURE.REFUNDED" || type === "PAYMENT.CAPTURE.REVERSED") {
      await db.update(captures).set({ status: remote.status, updatedAt: ctx.now() }).where(eq(captures.id, stored.id));
      await logBookingEvent(db, {
        bookingId: stored.bookingId,
        actor: "webhook",
        flag: type.split(".").pop()!.toLowerCase(),
        detail: { capture: resourceId },
      });
      return;
    }
    if (remote.status === stored.status) return;
    const auth = await getAuthorization(db, stored.authorizationId);
    if (remote.status === "COMPLETED" || remote.status === "DECLINED" || remote.status === "FAILED") {
      await processCaptureStatus(ctx, stored, remote.status);
      return;
    }
    await applyCapture(ctx, stored.bookingId, stored.kind as CaptureKind, auth, {
      paypalCaptureId: remote.id,
      status: remote.status,
      amountCents: payPalToCents(remote.amount.value),
      finalCapture: remote.final_capture ?? true,
    });
    return;
  }

  if (type.startsWith("INVOICING.INVOICE.")) {
    const [row] = await db.select().from(invoices).where(eq(invoices.paypalInvoiceId, resourceId));
    if (row) await syncInvoice(ctx, row.id);
    return;
  }

  if (type.startsWith("PAYMENT.PAYOUTSBATCH.")) {
    const rows = await db.select().from(payouts).where(eq(payouts.paypalBatchId, resourceId));
    for (const row of rows) await syncPayout(ctx, row.id);
    return;
  }

  if (type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    const raw = event.raw as { resource?: { payout_batch_id?: string; payout_item?: { sender_item_id?: string } } };
    const senderItemId = raw.resource?.payout_item?.sender_item_id;
    const [row] = await db
      .select()
      .from(payouts)
      .where(senderItemId ? eq(payouts.senderItemId, senderItemId) : eq(payouts.paypalItemId, resourceId));
    if (row) await syncPayout(ctx, row.id);
  }
}

async function isChainOf(
  tx: Parameters<Parameters<PaymentContext["db"]["transaction"]>[0]>[0],
  activeId: string | null,
  candidateId: string,
): Promise<boolean> {
  if (!activeId) return false;
  const [active] = await tx.select().from(authorizations).where(eq(authorizations.id, activeId));
  return active?.parentAuthorizationId === candidateId;
}

/** Unprocessed events older than a minute, for the reconciler (SPEC §11.5: PayPal also retries). */
export async function unprocessedEventIds(ctx: PaymentContext, limit: number): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(
      and(
        isNull(webhookEvents.processedAt),
        lt(webhookEvents.receivedAt, new Date(ctx.now().getTime() - 60_000)),
        lt(webhookEvents.attempts, 25),
      ),
    )
    .limit(limit);
  return rows.map((r) => r.id);
}
