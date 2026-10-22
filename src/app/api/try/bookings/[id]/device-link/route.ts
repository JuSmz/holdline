import QRCode from "qrcode";

import { getDb } from "@/db/client";
import { appUrl } from "@/server/config/env";
import { TTL_GRACE_MS } from "@/server/payments/authorize";
import { issuePayToken } from "@/server/payments/pay-tokens";
import { needsBuyer } from "@/server/try/pay";
import { consume } from "@/server/security/rate-limit";
import { tryApiGuard, workspaceBooking } from "@/server/workspaces/guard";

export const dynamic = "force-dynamic";

/** Device-link lifetime: short, and never past the booking's own pay window. */
const DEVICE_LINK_MS = 30 * 60_000;

/**
 * "Open on my phone" (SPEC §16, §20): mints a NEW single-use device_link pay token on demand, so the
 * call page never holds a reusable pay token.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/try/bookings/[id]/device-link">) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const booking = await workspaceBooking(guard.ws, (await ctx.params).id);
  const now = new Date();
  // Only while the buyer can still approve: a hold window that already closed gets no new link.
  const windowOpen = booking && (booking.holdExpiresAt > now || booking.status === "authorized");
  if (!booking || !needsBuyer(booking) || !windowOpen) {
    return Response.json(
      { ok: false, error: "not_payable", message: "This booking can't be paid any more." },
      { status: 409 },
    );
  }
  const limit = await consume(getDb(), { scope: "device_link", key: booking.id, window: "hour", limit: 10, now });
  if (!limit.ok) return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
  // Up to the end of the authorize grace: an approval started just before the window closes still counts.
  const until =
    booking.status === "pending_payment" ? booking.holdExpiresAt.getTime() + TTL_GRACE_MS : Number.POSITIVE_INFINITY;
  const expiresAt = new Date(Math.min(now.getTime() + DEVICE_LINK_MS, until));
  const token = await issuePayToken(getDb(), { bookingId: booking.id, purpose: "device_link", expiresAt });
  const url = `${appUrl()}/pay/${token}`;
  // Our own SVG of our own URL: safe to inline on the call page.
  const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, width: 168, errorCorrectionLevel: "M" });
  return Response.json({ ok: true, url, qrSvg, expiresAt: expiresAt.toISOString() });
}
