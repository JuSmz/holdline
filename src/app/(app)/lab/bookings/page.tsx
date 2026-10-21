import { and, desc, eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { LabBookings, type LabBookingView } from "@/components/lab/lab-bookings";
import { getDb } from "@/db/client";
import { addonItems, bookingEvents, bookings, captures, invoices, payouts, services } from "@/db/schema";
import { MAIN_WORKSPACE_ID } from "@/db/seed";
import { BUSINESS } from "@/db/seed-data";
import { readVar } from "@/server/config/env";
import { slotLabel } from "@/server/domain/time";
import { labAccess } from "@/server/lab";
import { formatUsd } from "@/server/money";

export const metadata: Metadata = { title: "Booking lab", robots: { index: false, follow: false } };

/** The first sandbox buyer's email from SANDBOX_BUYERS (passwords are never read here). */
function defaultPayerEmail(): string {
  try {
    const buyers = JSON.parse(readVar(process.env, "SANDBOX_BUYERS") ?? "[]") as { email?: unknown }[];
    const email = buyers.find((b) => typeof b.email === "string")?.email;
    return typeof email === "string" ? email : "";
  } catch {
    return "";
  }
}

/** Stage-6 lab: real sandbox payments through the payment services, on the main workspace. */
export default async function BookingLabPage() {
  const access = await labAccess();
  if (access === "disabled") notFound();
  if (access === "login") redirect("/admin/login?next=/lab/bookings");

  const db = getDb();
  const [rows, svc, addons] = await Promise.all([
    db
      .select()
      .from(bookings)
      .where(and(eq(bookings.workspaceId, MAIN_WORKSPACE_ID), eq(bookings.sample, false)))
      .orderBy(desc(bookings.createdAt))
      .limit(12),
    db.select().from(services).where(eq(services.workspaceId, MAIN_WORKSPACE_ID)).orderBy(services.sortOrder),
    db.select().from(addonItems).where(eq(addonItems.workspaceId, MAIN_WORKSPACE_ID)),
  ]);
  const ids = rows.map((r) => r.id);
  const [events, caps, pays, invs] = ids.length
    ? await Promise.all([
        db.select().from(bookingEvents).where(inArray(bookingEvents.bookingId, ids)).orderBy(bookingEvents.at),
        db.select().from(captures).where(inArray(captures.bookingId, ids)),
        db.select().from(payouts).where(inArray(payouts.bookingId, ids)),
        db.select().from(invoices).where(inArray(invoices.bookingId, ids)),
      ])
    : [[], [], [], []];

  const views: LabBookingView[] = rows.map((b) => ({
    id: b.id,
    ref: b.ref,
    service: b.serviceName,
    slot: slotLabel(b.slotStart, b.slotEnd, BUSINESS.timezone),
    price: formatUsd(b.priceCents),
    fee: formatUsd(b.noShowFeeCents),
    status: b.status,
    flag: b.paymentIssue,
    holdExpiresAt: b.holdExpiresAt.toISOString(),
    events: events
      .filter((e) => e.bookingId === b.id)
      .map(
        (e) =>
          `${e.at.toISOString().slice(11, 19)} ${e.fromStatus ?? "·"}→${e.toStatus ?? "·"} ${e.flag ?? ""} ${e.reason ?? ""} (${e.actor})`,
      ),
    money: [
      ...caps
        .filter((c) => c.bookingId === b.id)
        .map((c) => `capture ${c.kind} ${formatUsd(c.amountCents)} ${c.status}`),
      ...invs
        .filter((i) => i.bookingId === b.id)
        .map((i) => `invoice ${i.invoiceNumber} ${formatUsd(i.totalCents)} ${i.status}`),
      ...pays
        .filter((p) => p.bookingId === b.id)
        .map((p) => `payout #${p.attemptNo} ${formatUsd(p.amountCents)} ${p.status}`),
    ],
  }));

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-6 py-10">
      <header>
        <p className="text-sm font-medium text-brand">Owner lab · Payment services on the sandbox</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Booking lab</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Creates bookings in the main workspace and runs every payment step through the same services the product uses:
          order, authorize, Job done, No-show, cancel, waive, retry capture, bill via invoice, extra work and payouts.
          &quot;Run tick&quot; runs the 5-minute jobs now.
        </p>
      </header>
      <LabBookings
        clientId={readVar(process.env, "PAYPAL_CLIENT_ID") ?? ""}
        services={svc.map((s) => ({ key: s.key, label: `${s.name} (${formatUsd(s.priceCents)})` }))}
        addons={addons.map((a) => ({ key: a.key, label: `${a.name} (${formatUsd(a.unitPriceCents)})` }))}
        defaultPayerEmail={defaultPayerEmail()}
        bookings={views}
      />
    </div>
  );
}
