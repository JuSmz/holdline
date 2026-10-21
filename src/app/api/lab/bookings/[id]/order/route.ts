import { labApiGuard } from "@/server/lab";
import { labBooking } from "@/server/lab-bookings";
import { createOrderForBooking } from "@/server/payments/authorize";
import { defaultContext } from "@/server/payments/context";
import { paymentErrorResponse } from "@/server/payments/http";

export const dynamic = "force-dynamic";

/** createOrder for the PayPal button: the amount comes from the booking's snapshot (SPEC §9.2). */
export async function POST(request: Request, ctx: RouteContext<"/api/lab/bookings/[id]/order">) {
  const denied = await labApiGuard(request);
  if (denied) return denied;
  try {
    const booking = await labBooking((await ctx.params).id);
    return Response.json(await createOrderForBooking(defaultContext(), booking.id));
  } catch (error) {
    return paymentErrorResponse(error);
  }
}
