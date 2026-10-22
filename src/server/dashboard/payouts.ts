import { after } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";

import { payouts, technicians } from "@/db/schema";
import { dbErrorCode } from "@/server/db-error";
import type { PaymentContext } from "@/server/payments/context";
import { sendPayout, syncPayout } from "@/server/payments/payouts";
import { consume } from "@/server/security/rate-limit";
import type { Workspace } from "@/server/workspaces/guard";

/**
 * Money movement the owner sees within seconds (docs/design-system.md): the technician's payout goes out
 * right after the capture, and the dashboard poll follows it to "Paid out".
 *
 * No double sends: `sendPayout` runs under the ledger key `payout:<payoutId>` with the deterministic
 * request ID and sender_batch_id, only from status `pending`, and its row update is conditional on
 * `pending`. The scheduled tick (job 6) may send the same row concurrently; the second caller waits
 * for or replays the first result, and PayPal rejects a repeated sender_batch_id anyway.
 */

/** Sends this booking's queued payouts (whose technician has a payout email), one after another. */
export async function sendBookingPayouts(ctx: PaymentContext, bookingId: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: payouts.id })
    .from(payouts)
    .innerJoin(technicians, eq(technicians.id, payouts.technicianId))
    .where(
      and(
        eq(payouts.bookingId, bookingId),
        eq(payouts.status, "pending"),
        eq(payouts.sample, false),
        isNotNull(technicians.payoutEmail),
      ),
    );
  for (const row of rows) await sendPayout(ctx, row.id);
  return rows.length;
}

/** Runs sendBookingPayouts after the response (inside a request), otherwise right away. Errors are logged only. */
export function schedulePayouts(ctx: PaymentContext, bookingId: string): void {
  const run = () =>
    sendBookingPayouts(ctx, bookingId).catch((error: unknown) => {
      // The tick re-drives it (job 6); the ledger keeps a second attempt from paying twice.
      console.error(`[holdline] payout after capture for ${bookingId} failed: ${dbErrorCode(error)}`);
    });
  try {
    after(run);
  } catch {
    void run();
  }
}

/** At most one payout sync per workspace in this many ms, however many tabs poll. */
export const PAYOUT_SYNC_EVERY_MS = 5_000;
const SYNC_BATCH = 5;

/**
 * Follows this workspace's payouts that PayPal is still processing (GET the batch), throttled through
 * the rate counters to one sync per 5 s per workspace. `syncPayout` moves the booking to paid_out once
 * every main payout succeeded (maybePaidOut). Returns how many payouts were synced.
 */
export async function syncWorkspacePayouts(ctx: PaymentContext, ws: Workspace): Promise<number> {
  const rows = await ctx.db
    .select({ id: payouts.id })
    .from(payouts)
    .where(and(eq(payouts.workspaceId, ws.id), eq(payouts.status, "processing"), eq(payouts.sample, false)))
    .orderBy(payouts.updatedAt)
    .limit(SYNC_BATCH);
  if (rows.length === 0) return 0;
  const now = ctx.now();
  // One counter per 5-second slot of the current minute: the first poll in a slot syncs, the rest skip.
  // The rows expire after two minutes; the tick's retention step deletes them.
  const slot = Math.floor((now.getTime() % 60_000) / PAYOUT_SYNC_EVERY_MS);
  const gate = await consume(ctx.db, {
    scope: "dashboard_payout_sync",
    key: `${ws.id}:${slot}`,
    window: "minute",
    limit: 1,
    now,
  });
  if (!gate.ok) return 0;
  let synced = 0;
  for (const row of rows) {
    try {
      await syncPayout(ctx, row.id);
      synced += 1;
    } catch (error) {
      console.error(`[holdline] dashboard payout sync failed: ${dbErrorCode(error)}`);
    }
  }
  return synced;
}
