import { z } from "zod";

import { orderIdSchema, payAuthorize, payLinkGuard, spendDeviceLink } from "@/server/try/pay";
import { readJsonLimited } from "@/server/http/body";

export const dynamic = "force-dynamic";

const input = z.object({ orderId: z.string().regex(orderIdSchema) });

/** onApprove from the /pay/{token} page; a device link is spent once the hold is authorized. */
export async function POST(request: Request, ctx: RouteContext<"/api/pay/[token]/authorize">) {
  const { token } = await ctx.params;
  const found = await payLinkGuard(request, token);
  if (found instanceof Response) return found;
  const body = await readJsonLimited(request, 2048, input);
  if (body instanceof Response) return body;
  return spendDeviceLink(token, await payAuthorize(found.booking.id, body.orderId));
}
