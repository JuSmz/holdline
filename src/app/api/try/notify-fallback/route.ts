import { and, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/db/client";
import { callNotifications } from "@/db/schema";
import { noticeText, STUCK_CLAIM_MS } from "@/server/agent/notify";
import { readJsonLimited } from "@/server/http/body";
import { tryApiGuard, workspaceBooking, workspaceCall } from "@/server/workspaces/guard";

export const dynamic = "force-dynamic";

const input = z.object({ bookingId: z.uuid() });

/**
 * Browser fallback for the mid-call confirmation (SPEC §16 step 7): only when nothing claimed it yet,
 * the server's `say` definitely failed, or the server's claim never settled. Returns the same fixed
 * sentence for `vapi.say` and records `via: browser`, once. A timed-out say is never repeated.
 */
export async function POST(request: Request) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const body = await readJsonLimited(request, 1024, input);
  if (body instanceof Response) return body;
  const booking = await workspaceBooking(guard.ws, body.bookingId);
  const call = booking?.callId ? await workspaceCall(guard.ws, booking.callId) : null;
  if (!booking || !call || call.channel !== "web") {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (booking.status !== "authorized") return Response.json({ ok: false, error: "not_authorized" }, { status: 409 });

  const db = getDb();
  // Render first (a plain read): a failure here must not leave the notice claimed by the browser.
  const say = await noticeText(db, booking.id, "authorized");
  const taken = { via: "browser" as const, ok: true, outcome: "browser" };
  const claimed =
    (
      await db
        .insert(callNotifications)
        .values({ bookingId: booking.id, status: "authorized", channel: "web", ...taken })
        .onConflictDoNothing()
        .returning({ id: callNotifications.id })
    ).length > 0 ||
    (
      await db
        .update(callNotifications)
        .set(taken)
        .where(
          and(
            eq(callNotifications.bookingId, booking.id),
            eq(callNotifications.status, "authorized"),
            eq(callNotifications.channel, "web"),
            eq(callNotifications.via, "server"),
            or(
              eq(callNotifications.outcome, "not_spoken"),
              and(
                isNull(callNotifications.outcome),
                lt(callNotifications.sentAt, new Date(Date.now() - STUCK_CLAIM_MS)),
              ),
            ),
          ),
        )
        .returning({ id: callNotifications.id })
    ).length > 0;
  if (!claimed) return Response.json({ ok: true, say: null });
  return Response.json({ ok: true, say });
}
