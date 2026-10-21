import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { readVar } from "@/server/config/env";
import { newBookingRef } from "@/server/domain/refs";

import {
  addonItems,
  authorizations,
  bookingEvents,
  bookings,
  calls,
  captures,
  customers,
  payouts,
  services,
  technicians,
  type WorkingHours,
} from "./schema";
import type { Executor } from "./types";

/**
 * The demo business every workspace is cloned from (SPEC §17). Code, not DB rows: the main workspace
 * and each /try workspace get the same catalog by stable keys.
 */
export const BUSINESS = { name: "Northside Plumbing & Electric", timezone: "America/Chicago" } as const;

const WEEKDAYS: [string, string][] = [["08:00", "18:00"]];
export const STANDARD_HOURS: WorkingHours = {
  "1": WEEKDAYS,
  "2": WEEKDAYS,
  "3": WEEKDAYS,
  "4": WEEKDAYS,
  "5": WEEKDAYS,
  "6": [["09:00", "13:00"]],
};

export const SERVICES = [
  {
    key: "drain-cleaning",
    name: "Drain cleaning",
    category: "plumbing",
    description: "Clear one blocked sink, shower or floor drain.",
    priceCents: 14_900,
    durationMin: 90,
    noShowFeeCents: 4_900,
    isEmergency: false,
  },
  {
    key: "leak-repair",
    name: "Leak repair",
    category: "plumbing",
    description: "Find and fix one leaking pipe, joint or fitting.",
    priceCents: 16_900,
    durationMin: 90,
    noShowFeeCents: 4_900,
    isEmergency: false,
  },
  {
    key: "water-heater-flush",
    name: "Water heater flush",
    category: "plumbing",
    description: "Drain and flush a tank water heater, check the anode and valves.",
    priceCents: 18_900,
    durationMin: 90,
    noShowFeeCents: 4_900,
    isEmergency: false,
  },
  {
    key: "faucet-replacement",
    name: "Faucet replacement",
    category: "plumbing",
    description: "Remove the old faucet and install a customer-supplied one.",
    priceCents: 15_900,
    durationMin: 90,
    noShowFeeCents: 4_900,
    isEmergency: false,
  },
  {
    key: "plumbing-diagnostic",
    name: "Plumbing diagnostic visit",
    category: "plumbing",
    description: "A plumber finds the cause and quotes the fix on site.",
    priceCents: 8_900,
    durationMin: 60,
    noShowFeeCents: 2_900,
    isEmergency: false,
  },
  {
    key: "emergency-plumbing",
    name: "Emergency plumbing call-out",
    category: "plumbing",
    description: "Priority visit for active leaks, flooding or no water.",
    priceCents: 24_900,
    durationMin: 120,
    noShowFeeCents: 7_900,
    isEmergency: true,
  },
  {
    key: "outlet-switch-repair",
    name: "Outlet or switch repair",
    category: "electrical",
    description: "Diagnose and repair one faulty outlet or switch.",
    priceCents: 12_900,
    durationMin: 60,
    noShowFeeCents: 3_900,
    isEmergency: false,
  },
  {
    key: "light-fixture-install",
    name: "Light fixture installation",
    category: "electrical",
    description: "Install one customer-supplied ceiling or wall fixture.",
    priceCents: 14_900,
    durationMin: 90,
    noShowFeeCents: 4_900,
    isEmergency: false,
  },
  {
    key: "electrical-diagnostic",
    name: "Electrical diagnostic visit",
    category: "electrical",
    description: "An electrician finds the cause and quotes the fix on site.",
    priceCents: 8_900,
    durationMin: 60,
    noShowFeeCents: 2_900,
    isEmergency: false,
  },
  {
    key: "emergency-electrical",
    name: "Emergency electrical call-out",
    category: "electrical",
    description: "Priority visit for sparking, burning smells or total power loss.",
    priceCents: 24_900,
    durationMin: 120,
    noShowFeeCents: 7_900,
    isEmergency: true,
  },
] as const;

export const ADDONS = [
  { key: "shutoff-valve", name: "Replace shut-off valve", unitPriceCents: 2_500, unit: "valve" },
  { key: "p-trap", name: "Replace P-trap", unitPriceCents: 3_500, unit: "trap" },
  { key: "gfci-outlet", name: "Install GFCI outlet", unitPriceCents: 4_000, unit: "outlet" },
  { key: "smoke-detector", name: "Install smoke detector", unitPriceCents: 3_000, unit: "detector" },
  { key: "extra-labor", name: "Extra labor (30 min)", unitPriceCents: 4_500, unit: "30 min" },
  { key: "materials-kit", name: "Small materials kit", unitPriceCents: 1_500, unit: "kit" },
] as const;

export const TECHNICIANS = [
  { key: "maya", name: "Maya Torres", skills: ["plumbing"] as const, envKey: "TECH_PAYOUT_EMAIL_MAYA" },
  { key: "luis", name: "Luis Ramirez", skills: ["electrical"] as const, envKey: "TECH_PAYOUT_EMAIL_LUIS" },
] as const;

/** 60 % of recognised money goes to the technician (SPEC §7). */
export const PAYOUT_SHARE_BPS = 6_000;

/**
 * Inserts the catalog by stable key. Existing rows are never overwritten (owner edits survive),
 * except that a technician's missing payout email is filled in from env once it is configured.
 */
export async function seedCatalog(
  db: Executor,
  workspaceId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  await db
    .insert(services)
    .values(SERVICES.map((s, i) => ({ ...s, workspaceId, sortOrder: i })))
    .onConflictDoNothing({ target: [services.workspaceId, services.key] });
  await db
    .insert(addonItems)
    .values(ADDONS.map((a) => ({ ...a, workspaceId })))
    .onConflictDoNothing({ target: [addonItems.workspaceId, addonItems.key] });
  await db
    .insert(technicians)
    .values(
      TECHNICIANS.map((t) => ({
        workspaceId,
        key: t.key,
        name: t.name,
        skills: [...t.skills],
        payoutEmail: readVar(env, t.envKey) ?? null,
        payoutShareBps: PAYOUT_SHARE_BPS,
        workingHours: STANDARD_HOURS,
      })),
    )
    .onConflictDoUpdate({
      target: [technicians.workspaceId, technicians.key],
      set: { payoutEmail: sql`coalesce(${technicians.payoutEmail}, excluded.payout_email)` },
    });
}

const DAY = 24 * 3_600_000;

/**
 * Read-only sample history for a cloned demo workspace (SPEC §17): one paid-out job and one timely
 * cancellation, with their call, events, capture and payout. `sample = true` keeps every job and owner
 * action away from them; their PayPal IDs are fake and never sent anywhere.
 */
export async function seedSampleHistory(db: Executor, workspaceId: string, now: Date): Promise<void> {
  const [drain] = await db
    .select()
    .from(services)
    .where(sql`${services.workspaceId} = ${workspaceId} and ${services.key} = 'drain-cleaning'`);
  const [outlet] = await db
    .select()
    .from(services)
    .where(sql`${services.workspaceId} = ${workspaceId} and ${services.key} = 'outlet-switch-repair'`);
  const [maya] = await db
    .select()
    .from(technicians)
    .where(sql`${technicians.workspaceId} = ${workspaceId} and ${technicians.key} = 'maya'`);
  const [luis] = await db
    .select()
    .from(technicians)
    .where(sql`${technicians.workspaceId} = ${workspaceId} and ${technicians.key} = 'luis'`);
  if (!drain || !outlet || !maya || !luis) throw new Error("seed the catalog first");

  const at = (daysAgo: number, hour: number) =>
    new Date(Math.floor(now.getTime() / DAY) * DAY - daysAgo * DAY + hour * 3_600_000);
  const tag = randomUUID().slice(0, 8);
  // Refs are global (SPEC §10.4): draw real ones and retry on the rare collision.
  const insertBooking = async (values: Omit<typeof bookings.$inferInsert, "ref">) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // A savepoint, so a collision inside a caller's transaction doesn't abort it.
        return await db.transaction(async (sp) => {
          const [row] = await sp
            .insert(bookings)
            .values({ ...values, ref: newBookingRef() })
            .returning();
          return row;
        });
      } catch (error) {
        const code = (error as { cause?: { code?: string } }).cause?.code;
        if (code !== "23505" || attempt >= 5) throw error;
      }
    }
  };

  // 1. A paid-out drain cleaning.
  const [c1] = await db
    .insert(customers)
    .values({
      workspaceId,
      name: "Sample: Dana K.",
      email: "sample-dana@example.com",
      address: "Sample address, Austin TX",
    })
    .returning();
  const [call1] = await db
    .insert(calls)
    .values({
      workspaceId,
      channel: "web",
      sample: true,
      status: "ended",
      startedAt: at(6, 15),
      endedAt: at(6, 15.05),
      durationS: 184,
      transcript: "AI: Thanks for calling Northside Plumbing & Electric…\nUser: My kitchen sink is clogged…",
      summary: { headline: "Clogged kitchen sink, booked drain cleaning", sample: true },
      endedReason: "customer-ended-call",
    })
    .returning();
  const b1 = await insertBooking({
    workspaceId,
    status: "paid_out",
    serviceId: drain.id,
    technicianId: maya.id,
    customerId: c1.id,
    callId: call1.id,
    slotStart: at(5, 15),
    slotEnd: at(5, 17),
    serviceName: drain.name,
    priceCents: drain.priceCents,
    noShowFeeCents: drain.noShowFeeCents,
    problemSummary: "Kitchen sink drains slowly, standing water.",
    urgency: "soon",
    holdExpiresAt: at(6, 16),
    authorizedAt: at(6, 15.1),
    sample: true,
    statusChangedAt: at(5, 19),
  });
  const [a1] = await db
    .insert(authorizations)
    .values({
      bookingId: b1.id,
      paypalAuthorizationId: `SAMPLE-AUTH-${tag}-1`,
      status: "CAPTURED",
      amountCents: drain.priceCents,
      role: "active",
    })
    .returning();
  const [cap1] = await db
    .insert(captures)
    .values({
      bookingId: b1.id,
      authorizationId: a1.id,
      paypalCaptureId: `SAMPLE-CAP-${tag}-1`,
      kind: "full",
      amountCents: drain.priceCents,
      finalCapture: true,
      status: "COMPLETED",
    })
    .returning();
  await db.insert(payouts).values({
    workspaceId,
    bookingId: b1.id,
    source: "capture",
    sourceId: cap1.id,
    technicianId: maya.id,
    attemptNo: 1,
    amountCents: Math.floor((drain.priceCents * maya.payoutShareBps) / 10_000),
    senderBatchId: `sample-${tag}-1`,
    senderItemId: `sample-${tag}-1`,
    status: "succeeded",
    transactionStatus: "SUCCESS",
    sample: true,
  });
  const events1 = [
    [null, "pending_payment", "agent", at(6, 15.02)],
    ["pending_payment", "authorized", "customer", at(6, 15.1)],
    ["authorized", "completed", "owner", at(5, 17.2)],
    ["completed", "captured", "system", at(5, 17.21)],
    ["captured", "paid_out", "system", at(5, 19)],
  ] as const;
  await db.insert(bookingEvents).values(
    events1.map(([from, to, actor, when]) => ({
      bookingId: b1.id,
      fromStatus: from,
      toStatus: to,
      actor,
      at: when,
      reason: "sample",
    })),
  );

  // 2. A timely cancellation: hold released.
  const [c2] = await db
    .insert(customers)
    .values({
      workspaceId,
      name: "Sample: Ray P.",
      email: "sample-ray@example.com",
      address: "Sample address, Austin TX",
    })
    .returning();
  const b2 = await insertBooking({
    workspaceId,
    status: "voided",
    serviceId: outlet.id,
    technicianId: luis.id,
    customerId: c2.id,
    slotStart: at(2, 14),
    slotEnd: at(2, 16),
    serviceName: outlet.name,
    priceCents: outlet.priceCents,
    noShowFeeCents: outlet.noShowFeeCents,
    problemSummary: "Bathroom outlet stopped working.",
    urgency: "flexible",
    holdExpiresAt: at(4, 11),
    authorizedAt: at(4, 10.2),
    cancelReason: "owner",
    sample: true,
    statusChangedAt: at(3, 9),
  });
  await db.insert(authorizations).values({
    bookingId: b2.id,
    paypalAuthorizationId: `SAMPLE-AUTH-${tag}-2`,
    status: "VOIDED",
    amountCents: outlet.priceCents,
    role: "active",
  });
  const events2 = [
    [null, "pending_payment", "agent", at(4, 10)],
    ["pending_payment", "authorized", "customer", at(4, 10.2)],
    ["authorized", "cancelled", "owner", at(3, 9)],
    ["cancelled", "voided", "system", at(3, 9.01)],
  ] as const;
  await db.insert(bookingEvents).values(
    events2.map(([from, to, actor, when]) => ({
      bookingId: b2.id,
      fromStatus: from,
      toStatus: to,
      actor,
      at: when,
      reason: "sample",
    })),
  );
}
