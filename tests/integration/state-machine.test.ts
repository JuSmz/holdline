import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { bookingEvents, bookings, calls, payouts, services, technicians, workspaces } from "@/db/schema";
import { seedCatalog, seedSampleHistory, SERVICES } from "@/db/seed-data";
import { newBookingRef } from "@/server/domain/refs";
import {
  logBookingEvent,
  setPaymentIssue,
  transitionBooking,
  TransitionConflictError,
} from "@/server/domain/transition";

import { bookingById, catalogOf, makeBooking, makeWorkspace } from "../support/factory";

afterAll(async () => {
  await closeDb();
});

const pgError = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.cause?.code ?? err.code;
};
const constraint = (e: unknown) => (e as { cause?: { constraint_name?: string } }).cause?.constraint_name;

describe("database guards (SPEC §8.4)", () => {
  it("rejects a backward or skipping status change in raw SQL, allows a legal one", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const b = await makeBooking(db, ws.id);
    const raw = (status: string) => db.execute(sql`update bookings set status = ${status} where id = ${b.id}`);

    await expect(raw("completed")).rejects.toSatisfy((e) => pgError(e) === "23514");
    await raw("authorized");
    await expect(raw("pending_payment")).rejects.toSatisfy((e) => pgError(e) === "23514");
    expect((await bookingById(db, b.id)).status).toBe("authorized");
  });

  it("keeps the price snapshot immutable and the event log append-only", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const b = await makeBooking(db, ws.id);
    await expect(db.execute(sql`update bookings set price_cents = 1 where id = ${b.id}`)).rejects.toSatisfy(
      (e) => pgError(e) === "23514",
    );
    await logBookingEvent(db, { bookingId: b.id, actor: "system", flag: "note" });
    await expect(db.execute(sql`update booking_events set reason = 'x' where booking_id = ${b.id}`)).rejects.toSatisfy(
      (e) => pgError(e) === "23514",
    );
  });

  it("lets one live booking hold a technician's slot", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const b = await makeBooking(db, ws.id);
    const copy = () => ({ ...b, id: undefined, ref: newBookingRef(), version: 0 });
    await expect(db.insert(bookings).values(copy())).rejects.toSatisfy(
      (e) => pgError(e) === "23505" && constraint(e) === "bookings_live_slot_uq",
    );
    // Once the first one expires, the slot is free again.
    await db.transaction((tx) =>
      transitionBooking(tx, {
        bookingId: b.id,
        from: "pending_payment",
        to: "expired",
        actor: "system",
        reason: "ttl",
      }),
    );
    await db.insert(bookings).values(copy());
  });

  it("deletes a whole workspace with its calls, bookings, sample history and audit log", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    await seedSampleHistory(db, ws.id, new Date());
    const b = await makeBooking(db, ws.id);
    await logBookingEvent(db, { bookingId: b.id, actor: "system", flag: "note" });
    await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    expect(await db.select().from(bookings).where(eq(bookings.workspaceId, ws.id))).toHaveLength(0);
    expect(await db.select().from(calls).where(eq(calls.workspaceId, ws.id))).toHaveLength(0);
  });
});

describe("transitionBooking (compare-and-set)", () => {
  it("moves forward, bumps the version and logs the event", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const b = await makeBooking(db, ws.id);
    const result = await db.transaction((tx) =>
      transitionBooking(tx, { bookingId: b.id, from: "pending_payment", to: "authorized", actor: "customer" }),
    );
    expect(result).toMatchObject({ changed: true, booking: { status: "authorized", version: 1 } });
    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, b.id));
    expect(events).toMatchObject([{ fromStatus: "pending_payment", toStatus: "authorized", actor: "customer" }]);
  });

  it("treats an exact repeat as a silent no-op and a sibling as a visible 409", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const b = await makeBooking(db, ws.id, { status: "authorized" });
    const noShow = () =>
      db.transaction((tx) =>
        transitionBooking(tx, { bookingId: b.id, from: "authorized", to: "no_show", actor: "owner" }),
      );
    expect((await noShow()).changed).toBe(true);
    expect((await noShow()).changed).toBe(false);
    const jobDone = db.transaction((tx) =>
      transitionBooking(tx, { bookingId: b.id, from: "authorized", to: "completed", actor: "owner" }),
    );
    await expect(jobDone).rejects.toThrow(TransitionConflictError);
    await expect(jobDone).rejects.toThrow("Already marked as no-show.");
  });

  it("lets exactly one of two concurrent writers win", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const b = await makeBooking(db, ws.id, { status: "authorized" });
    const attempt = (to: "completed" | "no_show") =>
      db
        .transaction((tx) => transitionBooking(tx, { bookingId: b.id, from: "authorized", to, actor: "owner" }))
        .then(
          (r) => (r.changed ? "won" : "noop"),
          (e: unknown) => (e instanceof TransitionConflictError ? "409" : `error ${String(e)}`),
        );
    const results = await Promise.all([attempt("completed"), attempt("no_show"), attempt("completed")]);
    expect(results.filter((r) => r === "won")).toHaveLength(1);
    expect(results.every((r) => ["won", "noop", "409"].includes(r))).toBe(true);
    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, b.id));
    expect(events).toHaveLength(1);
  });

  it("refuses transitions outside the table before touching the row", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const b = await makeBooking(db, ws.id);
    await expect(
      db.transaction((tx) =>
        transitionBooking(tx, { bookingId: b.id, from: "pending_payment", to: "captured", actor: "owner" }),
      ),
    ).rejects.toThrow("illegal transition");
  });
});

describe("payment flags (SPEC §8.3)", () => {
  it("sets a flag only where allowed and clears it when the status moves on", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const b = await makeBooking(db, ws.id);
    await db.transaction((tx) =>
      setPaymentIssue(tx, { bookingId: b.id, flag: "authorization_pending", actor: "system" }),
    );
    await expect(
      db.transaction((tx) => setPaymentIssue(tx, { bookingId: b.id, flag: "capture_failed", actor: "system" })),
    ).rejects.toThrow(TransitionConflictError);
    const moved = await db.transaction((tx) =>
      transitionBooking(tx, { bookingId: b.id, from: "pending_payment", to: "authorized", actor: "webhook" }),
    );
    expect(moved.booking.paymentIssue).toBeNull();
    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, b.id));
    expect(events.map((e) => e.flag)).toEqual(["+authorization_pending", "-authorization_pending"]);
  });

  it("never carries a flag into a new status, and sets one in the same CAS when asked", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const b = await makeBooking(db, ws.id, { status: "authorized" });
    await db.transaction((tx) =>
      transitionBooking(tx, {
        bookingId: b.id,
        from: "authorized",
        to: "completed",
        actor: "owner",
        flag: "capture_failed",
      }),
    );
    expect((await bookingById(db, b.id)).paymentIssue).toBe("capture_failed");
    // A successful retry capture (or a paid fallback invoice) resolves capture_failed: payouts may proceed.
    const r = await db.transaction((tx) =>
      transitionBooking(tx, { bookingId: b.id, from: "completed", to: "captured", actor: "system" }),
    );
    expect(r.booking.paymentIssue).toBeNull();
    const cleared = await db.transaction((tx) =>
      setPaymentIssue(tx, { bookingId: b.id, flag: null, clearOnly: "payout_failed", actor: "system" }),
    );
    expect(cleared.changed).toBe(false);
  });
});

describe("seeding (SPEC §17)", () => {
  it("seeds the catalog idempotently and fills a payout email only once env has it", async () => {
    const db = getDb();
    const [ws] = await db
      .insert(workspaces)
      .values({ kind: "demo", label: "#seed", name: "Seed test", timezone: "America/Chicago" })
      .returning();
    await seedCatalog(db, ws.id, {});
    await db.update(services).set({ name: "Owner renamed" }).where(eq(services.workspaceId, ws.id));
    await seedCatalog(db, ws.id, { TECH_PAYOUT_EMAIL_MAYA: "maya@personal.example.com" });
    const { services: svc, tech } = await catalogOf(db, ws.id);
    expect(svc).toHaveLength(SERVICES.length);
    expect(svc.every((s) => s.name === "Owner renamed")).toBe(true);
    expect(tech("maya").payoutEmail).toBe("maya@personal.example.com");
    expect(tech("luis").payoutEmail).toBeNull();
    await seedCatalog(db, ws.id, { TECH_PAYOUT_EMAIL_MAYA: "other@personal.example.com" });
    const [maya] = await db
      .select()
      .from(technicians)
      .where(eq(technicians.id, tech("maya").id));
    expect(maya.payoutEmail).toBe("maya@personal.example.com");
  });

  it("adds read-only sample history with a paid-out job and a released hold", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    await seedSampleHistory(db, ws.id, new Date());
    const rows = await db.select().from(bookings).where(eq(bookings.workspaceId, ws.id));
    expect(rows.map((r) => [r.status, r.sample]).sort()).toEqual([
      ["paid_out", true],
      ["voided", true],
    ]);
    expect(rows.every((r) => /^HL-[0-9A-HJKMNP-TV-Z]{5}$/.test(r.ref))).toBe(true);
    const payoutRows = await db.select().from(payouts).where(eq(payouts.workspaceId, ws.id));
    expect(payoutRows).toMatchObject([{ status: "succeeded", sample: true, amountCents: 8_940 }]);
  });
});
