import { and, desc, eq, inArray } from "drizzle-orm";

import {
  bookingEvents,
  bookings,
  callNotifications,
  calls,
  captures,
  paypalOrders,
  technicians,
  workspaces,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { chatLines } from "@/server/chat/transcript";
import { slotLabel } from "@/server/domain/time";
import { formatUsd } from "@/server/money";
import { buyerFor } from "@/server/workspaces/demo";
import type { Workspace } from "@/server/workspaces/guard";
import { browserFallbackAllowed } from "@/server/agent/notify";

export type PanelState =
  | "waiting"
  | "processing"
  | "declined_retry"
  | "reapprove"
  | "authorized"
  | "done"
  | "late_cancel"
  | "no_show"
  | "fee_pending"
  | "missed"
  | "cancelled"
  | "expired";

export type BookingView = {
  id: string;
  ref: string;
  status: string;
  panel: PanelState;
  serviceName: string;
  appointment: string;
  technicianFirstName: string;
  holdAmount: string;
  noShowFee: string;
  holdExpiresAt: string;
};

/**
 * What the call and chat pages poll every 1.5 s (SPEC §16): the conversation's current booking, the
 * pay-panel state, whether the server-side confirmation landed, and (chat) the transcript lines.
 * Scoped to the workspace and the call. Never a pay token, an order ID or a controlUrl.
 */
export async function conversationState(db: Db, ws: Workspace, call: typeof calls.$inferSelect) {
  const rows = await db
    .select({ booking: bookings, tech: technicians.name })
    .from(bookings)
    .innerJoin(technicians, eq(technicians.id, bookings.technicianId))
    .where(and(eq(bookings.callId, call.id), eq(bookings.workspaceId, ws.id)))
    .orderBy(desc(bookings.createdAt));
  const current = rows.find((r) => r.booking.status !== "expired") ?? rows[0];
  let booking: BookingView | null = null;
  let notify: { status: string; ok: boolean | null; via: string | null; fallback: boolean } | null = null;
  if (current) {
    const b = current.booking;
    booking = {
      id: b.id,
      ref: b.ref,
      status: b.status,
      panel: await panelFor(db, b),
      serviceName: b.serviceName,
      appointment: slotLabel(b.slotStart, b.slotEnd, ws.timezone),
      technicianFirstName: current.tech.split(" ")[0],
      holdAmount: formatUsd(b.priceCents),
      noShowFee: formatUsd(b.noShowFeeCents),
      holdExpiresAt: b.holdExpiresAt.toISOString(),
    };
    const [n] = await db
      .select()
      .from(callNotifications)
      .where(and(eq(callNotifications.bookingId, b.id), inArray(callNotifications.status, ["authorized"])))
      .limit(1);
    notify = n ? { status: n.status, ok: n.ok, via: n.via, fallback: browserFallbackAllowed(n, new Date()) } : null;
  }
  const [wsRow] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
  return {
    call: { id: call.id, channel: call.channel, status: call.status },
    booking,
    notify,
    buyer: buyerFor(wsRow.sandboxBuyerIndex),
    lines: call.channel === "chat" ? chatLines(call) : undefined,
  };
}

/**
 * The pay panel's state for a booking (SPEC §16), shared by the call/chat pages and /pay/{token}.
 * An authorized hold that was lost or failed to renew needs the buyer again (SPEC §9.8).
 */
export async function panelFor(db: Db, b: typeof bookings.$inferSelect): Promise<PanelState> {
  switch (b.status) {
    case "pending_payment": {
      if (b.paymentIssue === "authorization_pending") return "processing";
      const [order] = await db
        .select({ status: paypalOrders.status })
        .from(paypalOrders)
        .where(eq(paypalOrders.bookingId, b.id))
        .orderBy(desc(paypalOrders.attempt))
        .limit(1);
      return order?.status === "DECLINED" || order?.status === "DENIED" ? "declined_retry" : "waiting";
    }
    case "authorized":
      return b.paymentIssue === "reauth_failed" || b.paymentIssue === "hold_lost" ? "reapprove" : "authorized";
    case "completed":
      return "done";
    case "captured":
    case "paid_out": {
      // A captured fee is not a finished job: say which fee it was.
      const [capture] = await db
        .select({ kind: captures.kind })
        .from(captures)
        .where(eq(captures.bookingId, b.id))
        .orderBy(desc(captures.createdAt))
        .limit(1);
      return capture?.kind === "late_cancel_fee" ? "late_cancel" : capture?.kind === "no_show_fee" ? "no_show" : "done";
    }
    // "Charged" only once the capture exists: a fee still being taken (or failed) is pending.
    case "no_show":
      return "fee_pending";
    case "cancelled":
      return b.cancelReason === "late" ? "fee_pending" : "cancelled";
    case "voided": {
      // A no-show without a fee ends voided: say the visit was missed, not cancelled.
      const [missed] = await db
        .select({ id: bookingEvents.id })
        .from(bookingEvents)
        .where(and(eq(bookingEvents.bookingId, b.id), eq(bookingEvents.toStatus, "no_show")))
        .limit(1);
      return missed ? "missed" : "cancelled";
    }
    case "expired":
      return "expired";
  }
}
