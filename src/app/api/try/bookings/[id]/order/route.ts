import { payOrder } from "@/server/try/pay";
import { tryApiGuard, workspaceBooking } from "@/server/workspaces/guard";

export const dynamic = "force-dynamic";

/** The pay panel's createOrder (SPEC §16): cookie-scoped; no pay token reaches the call page. */
export async function POST(request: Request, ctx: RouteContext<"/api/try/bookings/[id]/order">) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const booking = await workspaceBooking(guard.ws, (await ctx.params).id);
  if (!booking) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  return payOrder({ workspaceId: guard.ws.id }, booking.id);
}
