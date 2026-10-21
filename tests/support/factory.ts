import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Db } from "@/db/client";
import { bookings, customers, services, technicians, workspaces } from "@/db/schema";
import { seedCatalog } from "@/db/seed-data";
import { newBookingRef } from "@/server/domain/refs";

/** A fresh demo workspace with the Northside catalog; each test owns its own. */
export async function makeWorkspace(db: Db, env: Record<string, string | undefined> = {}) {
  const [ws] = await db
    .insert(workspaces)
    .values({
      kind: "demo",
      label: `#t-${randomUUID().slice(0, 6)}`,
      name: "Northside test",
      timezone: "America/Chicago",
    })
    .returning();
  await seedCatalog(db, ws.id, {
    TECH_PAYOUT_EMAIL_MAYA: "maya@personal.example.com",
    TECH_PAYOUT_EMAIL_LUIS: "luis@personal.example.com",
    ...env,
  });
  return ws;
}

export async function catalogOf(db: Db, workspaceId: string) {
  const svc = await db.select().from(services).where(eq(services.workspaceId, workspaceId));
  const techs = await db.select().from(technicians).where(eq(technicians.workspaceId, workspaceId));
  const service = (key: string) => svc.find((s) => s.key === key)!;
  const tech = (key: string) => techs.find((t) => t.key === key)!;
  return { services: svc, technicians: techs, service, tech };
}

const HOUR = 3_600_000;

/** A pending_payment booking for drain cleaning with Maya, `daysAhead` from `now` (default 2 days). */
export async function makeBooking(
  db: Db,
  workspaceId: string,
  options: { now?: Date; daysAhead?: number; serviceKey?: string; status?: typeof bookings.$inferInsert.status } = {},
) {
  const now = options.now ?? new Date();
  const { service, tech } = await catalogOf(db, workspaceId);
  const svc = service(options.serviceKey ?? "drain-cleaning");
  const technician = tech(svc.category === "plumbing" ? "maya" : "luis");
  const [customer] = await db
    .insert(customers)
    .values({ workspaceId, name: "Test Caller", email: "buyer@personal.example.com", address: "12 Main St" })
    .returning();
  // Unique per test run: a random minute offset keeps the live-slot index out of the way.
  const start = new Date(
    now.getTime() + (options.daysAhead ?? 2) * 24 * HOUR + Math.floor(Math.random() * 100_000) * 60_000,
  );
  const [booking] = await db
    .insert(bookings)
    .values({
      workspaceId,
      ref: newBookingRef(),
      status: options.status ?? "pending_payment",
      serviceId: svc.id,
      technicianId: technician.id,
      customerId: customer.id,
      slotStart: start,
      slotEnd: new Date(start.getTime() + 2 * HOUR),
      serviceName: svc.name,
      priceCents: svc.priceCents,
      noShowFeeCents: svc.noShowFeeCents,
      holdExpiresAt: new Date(now.getTime() + HOUR),
    })
    .returning();
  return booking;
}

export async function bookingById(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, id)));
  return row;
}
