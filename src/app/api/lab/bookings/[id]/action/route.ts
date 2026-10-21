import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/db/client";
import { addonItems, payouts } from "@/db/schema";
import { labApiGuard } from "@/server/lab";
import { labBooking } from "@/server/lab-bookings";
import { markJobDone, markNoShow, retryCapture } from "@/server/payments/capture";
import { defaultContext } from "@/server/payments/context";
import { paymentErrorResponse } from "@/server/payments/http";
import { billExtraWork, billViaInvoice } from "@/server/payments/invoices";
import { retryPayout } from "@/server/payments/payouts";
import { cancelBooking, waiveFee } from "@/server/payments/void";

export const dynamic = "force-dynamic";

const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("job_done") }),
  z.object({ action: z.literal("no_show") }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("waive_fee") }),
  z.object({ action: z.literal("retry_capture") }),
  z.object({ action: z.literal("bill_via_invoice") }),
  z.object({ action: z.literal("retry_payout") }),
  z.object({
    action: z.literal("extra_work"),
    addonKey: z.string().regex(/^[a-z0-9-]{1,40}$/),
    quantity: z.number().int().min(1).max(20),
  }),
]);

/** Owner actions on a lab booking, straight through the payment services (SPEC §9). */
export async function POST(request: Request, ctx: RouteContext<"/api/lab/bookings/[id]/action">) {
  const denied = await labApiGuard(request);
  if (denied) return denied;
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
  const body = parsed.data;
  try {
    const booking = await labBooking((await ctx.params).id);
    const payments = defaultContext();
    switch (body.action) {
      case "job_done":
        return Response.json(summary(await markJobDone(payments, booking.id)));
      case "no_show":
        return Response.json(summary(await markNoShow(payments, booking.id)));
      case "cancel": {
        const outcome = await cancelBooking(payments, booking.id);
        return Response.json({ ...summary(outcome), rule: outcome.rule, amountCents: outcome.amountCents });
      }
      case "waive_fee":
        return Response.json(summary(await waiveFee(payments, booking.id)));
      case "retry_capture":
        return Response.json(summary(await retryCapture(payments, booking.id)));
      case "bill_via_invoice": {
        const invoice = await billViaInvoice(payments, booking.id);
        return Response.json({
          ok: true,
          invoice: { number: invoice.invoiceNumber, status: invoice.status, payerViewUrl: invoice.payerViewUrl },
        });
      }
      case "extra_work": {
        const [addon] = await getDb()
          .select()
          .from(addonItems)
          .where(and(eq(addonItems.workspaceId, booking.workspaceId), eq(addonItems.key, body.addonKey)));
        if (!addon) return Response.json({ ok: false, error: "unknown_addon" }, { status: 404 });
        const invoice = await billExtraWork(payments, booking.id, [{ addonId: addon.id, quantity: body.quantity }]);
        return Response.json({
          ok: true,
          invoice: { number: invoice.invoiceNumber, status: invoice.status, payerViewUrl: invoice.payerViewUrl },
        });
      }
      case "retry_payout": {
        const [failed] = await getDb()
          .select()
          .from(payouts)
          .where(eq(payouts.bookingId, booking.id))
          .orderBy(desc(payouts.createdAt));
        if (!failed) return Response.json({ ok: false, error: "no_payout" }, { status: 404 });
        const row = await retryPayout(payments, failed.id);
        return Response.json({ ok: true, payout: { attempt: row.attemptNo, status: row.status } });
      }
    }
  } catch (error) {
    return paymentErrorResponse(error);
  }
}

function summary(outcome: { status: string; booking: { status: string; paymentIssue: string | null } }) {
  return {
    ok: true,
    outcome: outcome.status,
    bookingStatus: outcome.booking.status,
    flag: outcome.booking.paymentIssue,
  };
}
