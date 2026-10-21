import { eq } from "drizzle-orm";

import { captures } from "@/db/schema";
import { lockBooking, setPaymentIssue } from "@/server/domain/transition";

import type { PaymentContext } from "./context";
import { createPayoutRow, maybePaidOut } from "./payouts";

type CaptureRow = typeof captures.$inferSelect;

/**
 * A PENDING capture settled (webhook or poll, SPEC §9.3.4): COMPLETED clears `capture_pending` and creates
 * the payout row in the same transaction; DECLINED/FAILED turns it into `capture_failed` (Bill via invoice).
 */
export async function processCaptureStatus(
  ctx: PaymentContext,
  row: CaptureRow,
  status: "COMPLETED" | "DECLINED" | "FAILED",
): Promise<void> {
  const { db, paypal } = ctx;
  await db.transaction(async (tx) => {
    const b = await lockBooking(tx, row.bookingId);
    await tx.update(captures).set({ status, updatedAt: ctx.now() }).where(eq(captures.id, row.id));
    if (b.status !== "captured" || b.paymentIssue !== "capture_pending") return;
    if (status === "COMPLETED") {
      await setPaymentIssue(tx, { bookingId: b.id, flag: null, actor: "webhook", reason: "capture_completed" });
      await createPayoutRow(tx, {
        instanceId: paypal.instanceId,
        workspaceId: b.workspaceId,
        bookingId: b.id,
        technicianId: b.technicianId,
        source: "capture",
        sourceId: row.id,
        recognisedCents: row.amountCents,
      });
    } else {
      await setPaymentIssue(tx, {
        bookingId: b.id,
        flag: "capture_failed",
        actor: "webhook",
        reason: "capture_declined",
      });
    }
  });
  if (status === "COMPLETED") await maybePaidOut(ctx, row.bookingId);
}
