import { payLinkGuard, payOrder } from "@/server/try/pay";

export const dynamic = "force-dynamic";

/** createOrder from the /pay/{token} page (email link or device link, SPEC §20). */
export async function POST(request: Request, ctx: RouteContext<"/api/pay/[token]/order">) {
  const found = await payLinkGuard(request, (await ctx.params).token);
  if (found instanceof Response) return found;
  return payOrder({ bookingId: found.booking.id }, found.booking.id);
}
