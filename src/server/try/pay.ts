import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { bookings, paypalOrders, technicians, workspaces } from "@/db/schema";
import { authorizeBooking, createOrderForBooking } from "@/server/payments/authorize";
import { defaultContext } from "@/server/payments/context";
import { PaymentStateError } from "@/server/payments/context";
import { paymentErrorResponse } from "@/server/payments/http";
import { fakePayPal } from "@/server/paypal";
import { readVar } from "@/server/config/env";
import { findPayToken, spendDeviceToken } from "@/server/payments/pay-tokens";
import { consume } from "@/server/security/rate-limit";
import { isSameOrigin } from "@/server/security/same-origin";

/**
 * Pay-order creation limits (SPEC §20): per private demo workspace for the cookie routes, per booking
 * for pay links (a shared workspace must not be locked by one link holder), plus one global cap.
 */
export const ORDER_LIMITS = { perWorkspaceHour: 30, perBookingHour: 10, globalHour: 600 } as const;

export const payPalMocked = () => readVar(process.env, "PAYPAL_MODE") === "mock";

export type OrderLimitKey = { workspaceId: string } | { bookingId: string };

async function orderLimit(key: OrderLimitKey) {
  const db = getDb();
  const now = new Date();
  const own =
    "workspaceId" in key
      ? { scope: "pay_order", key: key.workspaceId, limit: ORDER_LIMITS.perWorkspaceHour }
      : { scope: "pay_order_link", key: key.bookingId, limit: ORDER_LIMITS.perBookingHour };
  const first = await consume(db, { ...own, window: "hour", now });
  const global = first.ok
    ? await consume(db, {
        scope: "pay_order_global",
        key: "global",
        window: "hour",
        limit: ORDER_LIMITS.globalHour,
        now,
      })
    : null;
  if (!first.ok || !global?.ok) {
    throw new PaymentStateError("Too many payment attempts — try again later.", 429, "rate_limited");
  }
}

/** createOrder for the pay panel; the amount comes from the booking snapshot only (SPEC §9.2). */
export async function payOrder(limitKey: OrderLimitKey, bookingId: string): Promise<Response> {
  try {
    await orderLimit(limitKey);
    return Response.json(await createOrderForBooking(defaultContext(), bookingId));
  } catch (error) {
    return paymentErrorResponse(error);
  }
}

/** onApprove: authorize through the ledger; the notice reaches the call or chat after the response. */
export async function payAuthorize(bookingId: string, orderId: string): Promise<Response> {
  try {
    const outcome = await authorizeBooking(defaultContext(), bookingId, orderId, "customer");
    return Response.json({ ok: true, status: outcome.status, bookingStatus: outcome.booking.status });
  } catch (error) {
    return paymentErrorResponse(error);
  }
}

/** PAYPAL_MODE=mock only (local, e2e): the buyer "approves" in the fake PayPal, then the real authorize. */
export async function payMockApprove(limitKey: OrderLimitKey, bookingId: string): Promise<Response> {
  if (!payPalMocked()) return new Response(null, { status: 404 });
  try {
    await orderLimit(limitKey);
    const ctx = defaultContext();
    let { orderId } = await createOrderForBooking(ctx, bookingId);
    if (!fakePayPal().orders.has(orderId)) {
      // An open order from before a mock-server restart: the new fake doesn't know it. Retire it.
      await getDb().update(paypalOrders).set({ status: "VOIDED" }).where(eq(paypalOrders.paypalOrderId, orderId));
      ({ orderId } = await createOrderForBooking(ctx, bookingId));
    }
    fakePayPal().approve(orderId);
    return payAuthorize(bookingId, orderId);
  } catch (error) {
    return paymentErrorResponse(error);
  }
}

export const orderIdSchema = /^[A-Z0-9]{5,40}$/;

/**
 * What a pay link shows: `live` when it can still be used to pay; otherwise only the booking's final
 * state, read-only. A device link is single-use (SPEC §20): spent once its booking is authorized, and
 * dead once the booking no longer needs the buyer. Null for an unknown or expired link.
 */
export async function payLinkView(token: string) {
  const db = getDb();
  const row = await findPayToken(db, token, new Date());
  if (!row) return null;
  const [found] = await db
    .select({ booking: bookings, ws: workspaces, tech: technicians.name })
    .from(bookings)
    .innerJoin(workspaces, eq(workspaces.id, bookings.workspaceId))
    .innerJoin(technicians, eq(technicians.id, bookings.technicianId))
    .where(eq(bookings.id, row.bookingId));
  if (!found) return null;
  const live = row.usedAt === null && needsBuyer(found.booking);
  return { ...found, token: row, live };
}

/** The booking behind a live pay link, for the routes that act on it; null otherwise. */
export async function payLinkBooking(token: string) {
  const view = await payLinkView(token);
  return view && (view.live || view.token.purpose === "email_link") ? view : null;
}

/** Pending payment, or an authorized hold that was lost or failed to renew (SPEC §9.8). */
export function needsBuyer(b: typeof bookings.$inferSelect): boolean {
  return (
    b.status === "pending_payment" ||
    (b.status === "authorized" && (b.paymentIssue === "hold_lost" || b.paymentIssue === "reauth_failed"))
  );
}

/** Route guard for /api/pay/{token}/*: Origin check, then a live link. */
export async function payLinkGuard(request: Request, token: string) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "bad_origin" }, { status: 403 });
  const found = await payLinkBooking(token);
  if (!found) {
    return Response.json({ ok: false, error: "link_expired", message: "This link has expired." }, { status: 410 });
  }
  return found;
}

/** A device link is single-use: spent once its booking is authorized. */
export async function spendDeviceLink(token: string, response: Response): Promise<Response> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { status?: string } | null;
  if (body?.status === "authorized") await spendDeviceToken(getDb(), token, new Date());
  return response;
}
