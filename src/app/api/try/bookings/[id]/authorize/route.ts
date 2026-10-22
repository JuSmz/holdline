import { z } from "zod";

import { orderIdSchema, payAuthorize } from "@/server/try/pay";
import { tryApiGuard, workspaceBooking } from "@/server/workspaces/guard";
import { readJsonLimited } from "@/server/http/body";

export const dynamic = "force-dynamic";

const input = z.object({ orderId: z.string().regex(orderIdSchema) });

/** The pay panel's onApprove (SPEC §9.2, §16). */
export async function POST(request: Request, ctx: RouteContext<"/api/try/bookings/[id]/authorize">) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const body = await readJsonLimited(request, 2048, input);
  if (body instanceof Response) return body;
  const booking = await workspaceBooking(guard.ws, (await ctx.params).id);
  if (!booking) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  return payAuthorize(booking.id, body.orderId);
}
