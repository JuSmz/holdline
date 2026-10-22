import { getDb } from "@/db/client";
import { dbErrorCode } from "@/server/db-error";
import { bookingDetail } from "@/server/dashboard/queries";
import { tryApiGuard } from "@/server/workspaces/guard";

export const dynamic = "force-dynamic";

/** The booking sheet: summary, timeline, PayPal objects and actions. Only bookings of this demo copy. */
export async function GET(request: Request, ctx: RouteContext<"/api/dashboard/bookings/[id]">) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  try {
    const detail = await bookingDetail(getDb(), guard.ws, (await ctx.params).id, new Date());
    if (!detail) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    return Response.json({ ok: true, ...detail }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error(`[holdline] booking detail failed: ${dbErrorCode(error)}`);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
