import { payLinkGuard, payMockApprove, spendDeviceLink } from "@/server/try/pay";

export const dynamic = "force-dynamic";

/** PAYPAL_MODE=mock only: the fake PayPal approval on the /pay/{token} page. */
export async function POST(request: Request, ctx: RouteContext<"/api/pay/[token]/mock-approve">) {
  const { token } = await ctx.params;
  const found = await payLinkGuard(request, token);
  if (found instanceof Response) return found;
  return spendDeviceLink(token, await payMockApprove({ bookingId: found.booking.id }, found.booking.id));
}
