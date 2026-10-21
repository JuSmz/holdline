import { z } from "zod";

import { labApiGuard } from "@/server/lab";
import { labBooking } from "@/server/lab-bookings";
import { authorizeBooking } from "@/server/payments/authorize";
import { defaultContext } from "@/server/payments/context";
import { paymentErrorResponse } from "@/server/payments/http";

export const dynamic = "force-dynamic";

const input = z.object({ orderId: z.string().regex(/^[A-Z0-9]{5,40}$/) });

/** onApprove: authorize through the ledger (SPEC §9.2). */
export async function POST(request: Request, ctx: RouteContext<"/api/lab/bookings/[id]/authorize">) {
  const denied = await labApiGuard(request);
  if (denied) return denied;
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
  try {
    const booking = await labBooking((await ctx.params).id);
    const outcome = await authorizeBooking(defaultContext(), booking.id, parsed.data.orderId, "customer");
    return Response.json({ ok: true, status: outcome.status, bookingStatus: outcome.booking.status });
  } catch (error) {
    return paymentErrorResponse(error);
  }
}
