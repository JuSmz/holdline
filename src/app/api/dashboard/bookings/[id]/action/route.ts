import { actionInput, cancelRefusal, runDashboardAction } from "@/server/dashboard/actions";
import { readJsonLimited } from "@/server/http/body";
import { defaultContext } from "@/server/payments/context";
import { paymentErrorResponse } from "@/server/payments/http";
import { tryApiGuard, workspaceBooking } from "@/server/workspaces/guard";

export const dynamic = "force-dynamic";

/**
 * Owner actions on a booking of this demo copy (SPEC §18): Job done, No-show, Cancel, Waive fee, Add extra
 * work, Retry capture, Bill via invoice, Retry payout. Amounts come from the booking and the catalog only;
 * the body names the action (add-on keys with quantities, the payout to retry), never an amount.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/dashboard/bookings/[id]/action">) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const body = await readJsonLimited(request, 2048, actionInput);
  if (body instanceof Response) return body;
  const booking = await workspaceBooking(guard.ws, (await ctx.params).id);
  if (!booking) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  if (booking.sample)
    return Response.json({ ok: false, error: "sample", message: "Sample history is read-only." }, { status: 409 });
  // The dialog stated a rule (no hold, late fee or free); if it no longer holds, ask again.
  const refusal = cancelRefusal(guard.ws, booking, body, new Date());
  if (refusal) return Response.json({ ok: false, ...refusal }, { status: 409 });
  try {
    return Response.json(await runDashboardAction(defaultContext(), guard.ws, booking, body));
  } catch (error) {
    return paymentErrorResponse(error);
  }
}
