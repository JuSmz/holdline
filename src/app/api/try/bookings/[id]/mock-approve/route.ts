import { payMockApprove } from "@/server/try/pay";
import { tryApiGuard, workspaceBooking } from "@/server/workspaces/guard";

export const dynamic = "force-dynamic";

/** PAYPAL_MODE=mock only: stands in for the PayPal popup in local runs and the e2e test. */
export async function POST(request: Request, ctx: RouteContext<"/api/try/bookings/[id]/mock-approve">) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const booking = await workspaceBooking(guard.ws, (await ctx.params).id);
  if (!booking) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  return payMockApprove({ workspaceId: guard.ws.id }, booking.id);
}
