import { desc, eq, inArray } from "drizzle-orm";

import { bookingEvents, bookings, customers, outboxEmails, paymentOperations } from "@/db/schema";
import type { Db } from "@/db/types";
import { policyOf } from "@/server/domain/policy";
import { slotLabel } from "@/server/domain/time";
import { formatUsd } from "@/server/money";
import type { Workspace } from "@/server/workspaces/guard";

/** The PayPal side of an operation key, in owner words (SPEC §18 activity feed). */
const OPERATION_LABEL: Record<string, string> = {
  "order-create": "PayPal order created",
  authorize: "Hold authorized",
  capture: "Capture",
  void: "Hold released (void)",
  "void-orphan": "Stray hold released",
  "void-replaced": "Old hold released",
  reauth: "Hold renewed (reauthorize)",
  payout: "Technician payout",
  "payout-cancel": "Unclaimed payout cancelled",
  invoice: "Invoice",
  extra_work: "Extra-work invoice",
  fallback: "Fallback invoice",
};

/** Minimal owner dashboard data (stage 7): bookings, the PayPal activity feed, the outbox. */
export async function dashboardData(db: Db, ws: Workspace) {
  const policy = policyOf(ws.policy);
  const rows = await db
    .select({ booking: bookings, customer: customers.name })
    .from(bookings)
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(eq(bookings.workspaceId, ws.id))
    .orderBy(desc(bookings.createdAt))
    .limit(50);
  const ids = rows.map((r) => r.booking.id);
  const refOf = new Map(rows.map((r) => [r.booking.id, r.booking.ref]));
  const [events, operations, outbox] = ids.length
    ? await Promise.all([
        db
          .select()
          .from(bookingEvents)
          .where(inArray(bookingEvents.bookingId, ids))
          .orderBy(desc(bookingEvents.at))
          .limit(40),
        db
          .select()
          .from(paymentOperations)
          .where(inArray(paymentOperations.bookingId, ids))
          .orderBy(desc(paymentOperations.createdAt))
          .limit(40),
        db
          .select()
          .from(outboxEmails)
          .where(eq(outboxEmails.workspaceId, ws.id))
          .orderBy(desc(outboxEmails.createdAt))
          .limit(20),
      ])
    : [[], [], []];

  const activity = [
    ...operations.map((op) => ({
      at: op.updatedAt,
      ref: op.bookingId ? (refOf.get(op.bookingId) ?? "") : "",
      text: `${OPERATION_LABEL[op.kind] ?? op.kind}: ${op.state === "succeeded" ? "done" : op.state === "failed" ? `failed (${op.lastError ?? "?"})` : "in progress"}`,
      source: "paypal" as const,
    })),
    ...events.map((e) => ({
      at: e.at,
      ref: refOf.get(e.bookingId) ?? "",
      text: `${e.fromStatus ?? "new"} → ${e.toStatus}${e.reason ? ` (${e.reason})` : ""} by ${e.actor}`,
      source: "booking" as const,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 40);

  return {
    bookings: rows.map(({ booking: b, customer }) => ({
      id: b.id,
      ref: b.ref,
      status: b.status,
      flag: b.paymentIssue,
      sample: b.sample,
      serviceName: b.serviceName,
      appointment: slotLabel(b.slotStart, b.slotEnd, ws.timezone),
      customerFirstName: (customer ?? "").replace(/^Sample: /, "").split(" ")[0] || "—",
      amount: formatUsd(b.priceCents),
      noShowFee: formatUsd(b.noShowFeeCents),
      // The dialog states the rule at click time (SPEC §9.5, §18); the server refuses if it changed.
      slotStart: b.slotStart.toISOString(),
      cancelWindowHours: policy.cancellationWindowHours,
    })),
    activity: activity.map((a) => ({ ...a, at: a.at.toISOString() })),
    outbox: outbox.map((m) => ({
      id: m.id,
      template: m.template,
      subject: m.subject,
      status: m.status,
      html: previewHtml(m.html ?? ""),
      at: m.createdAt.toISOString(),
      ref: m.bookingId ? (refOf.get(m.bookingId) ?? "") : "",
    })),
  };
}

export type DashboardData = Awaited<ReturnType<typeof dashboardData>>;

/** Links in the sandboxed preview open in a new tab (the frame itself runs no scripts). */
function previewHtml(html: string): string {
  const base = '<base target="_blank">';
  return /<html[^>]*>/i.test(html) ? html.replace(/<html([^>]*)>/i, `<html$1><head>${base}</head>`) : base + html;
}
