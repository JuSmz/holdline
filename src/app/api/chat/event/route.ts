import { z } from "zod";

import { getDb } from "@/db/client";
import { notifyCall } from "@/server/agent/notify";
import { dbErrorCode } from "@/server/db-error";
import { tryApiGuard, workspaceBooking, workspaceCall } from "@/server/workspaces/guard";
import { readJsonLimited } from "@/server/http/body";

export const dynamic = "force-dynamic";

const input = z.object({ bookingId: z.uuid() });

/**
 * The pay panel's "payment approved" signal in the chat (SPEC §15): the server checks the booking is
 * authorized in the database, then appends the fixed confirmation at most once. Nothing the client
 * says is taken on trust; a repeat or a webhook that got there first is a no-op.
 */
export async function POST(request: Request) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const body = await readJsonLimited(request, 2048, input);
  if (body instanceof Response) return body;
  const booking = await workspaceBooking(guard.ws, body.bookingId);
  const chat = booking?.callId ? await workspaceCall(guard.ws, booking.callId) : null;
  if (!booking || !chat || chat.channel !== "chat")
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  if (booking.status !== "authorized") return Response.json({ ok: false, error: "not_authorized" }, { status: 409 });
  try {
    const result = await notifyCall(booking.id, "authorized", getDb());
    return Response.json({ ok: true, appended: result.sent });
  } catch (error) {
    console.error(`[holdline] chat confirmation for ${booking.id} failed: ${dbErrorCode(error)}`);
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}
