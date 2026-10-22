import { z } from "zod";

import { isLateCancellation, policyOf } from "@/server/domain/policy";
import { markJobDone, markNoShow } from "@/server/payments/capture";
import { defaultContext } from "@/server/payments/context";
import { paymentErrorResponse } from "@/server/payments/http";
import { cancelBooking } from "@/server/payments/void";
import { tryApiGuard, workspaceBooking } from "@/server/workspaces/guard";
import { readJsonLimited } from "@/server/http/body";

export const dynamic = "force-dynamic";

const input = z.object({
  action: z.enum(["job_done", "no_show", "cancel"]),
  /** Cancel: the rule the owner confirmed in the dialog. */
  expectLate: z.boolean().optional(),
});

/** The minimal owner actions (stage 7): Job done, No-show, Cancel; amounts come from the booking only. */
export async function POST(request: Request, ctx: RouteContext<"/api/dashboard/bookings/[id]/action">) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const body = await readJsonLimited(request, 2048, input);
  if (body instanceof Response) return body;
  const booking = await workspaceBooking(guard.ws, (await ctx.params).id);
  if (!booking) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  if (booking.sample)
    return Response.json({ ok: false, error: "sample", message: "Sample history is read-only." }, { status: 409 });
  if (body.action === "cancel" && body.expectLate !== undefined && booking.status === "authorized") {
    const late = isLateCancellation(policyOf(guard.ws.policy), booking.slotStart, new Date());
    if (late !== body.expectLate) {
      return Response.json(
        {
          ok: false,
          error: "rule_changed",
          message: "The cancellation rule changed since the dialog opened. Try again.",
        },
        { status: 409 },
      );
    }
  }
  try {
    const payments = defaultContext();
    const outcome =
      body.action === "job_done"
        ? await markJobDone(payments, booking.id)
        : body.action === "no_show"
          ? await markNoShow(payments, booking.id)
          : await cancelBooking(payments, booking.id);
    return Response.json({
      ok: true,
      outcome: outcome.status,
      bookingStatus: outcome.booking.status,
      flag: outcome.booking.paymentIssue,
    });
  } catch (error) {
    return paymentErrorResponse(error);
  }
}
