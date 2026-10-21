import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as action } from "@/app/api/lab/bookings/[id]/action/route";
import { POST as authorize } from "@/app/api/lab/bookings/[id]/authorize/route";
import { POST as order } from "@/app/api/lab/bookings/[id]/order/route";
import { POST as create } from "@/app/api/lab/bookings/route";
import { POST as tick } from "@/app/api/lab/bookings/tick/route";
import { closeDb, getDb } from "@/db/client";
import { bookings, services } from "@/db/schema";
import { MAIN_WORKSPACE_ID } from "@/db/seed";
import { BookingInputError, createPendingBooking, freeSlots } from "@/server/domain/bookings";
import { fakePayPal } from "@/server/paypal";

import { makeWorkspace } from "../support/factory";
import { resetPayments } from "../support/payments";

const guard = vi.hoisted(() => ({ denied: null as Response | null }));
vi.mock("@/server/lab", () => ({ labApiGuard: async () => guard.denied, labAccess: async () => "ok" }));

beforeEach(async () => {
  await resetPayments();
  guard.denied = null;
  // The lab routes use the production context; in tests that is the fake PayPal.
  vi.stubEnv("PAYPAL_MODE", "mock");
  vi.stubEnv("TECH_PAYOUT_EMAIL_MAYA", "maya@personal.example.com");
  await getDb().execute(
    `update technicians set payout_email = 'maya@personal.example.com' where workspace_id = '${MAIN_WORKSPACE_ID}' and key = 'maya'`,
  );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

const post = (url: string, body?: unknown) =>
  new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("booking lab routes (stage 6 done criterion)", () => {
  it("runs a booking from creation to paid_out through the payment services", async () => {
    const created = await create(
      post("/api/lab/bookings", { serviceKey: "drain-cleaning", payerEmail: "buyer@personal.example.com" }),
    );
    expect(created.status).toBe(200);
    const { booking } = (await created.json()) as { booking: { id: string; ref: string; slot: string } };
    expect(booking.slot).toMatch(/CT$/);

    const ordered = (await (await order(post(`/api/lab/bookings/${booking.id}/order`), params(booking.id))).json()) as {
      orderId: string;
    };
    fakePayPal().approve(ordered.orderId);
    const authorized = await authorize(
      post(`/api/lab/bookings/${booking.id}/authorize`, { orderId: ordered.orderId }),
      params(booking.id),
    );
    expect(await authorized.json()).toMatchObject({ ok: true, status: "authorized" });

    const done = await action(
      post(`/api/lab/bookings/${booking.id}/action`, { action: "job_done" }),
      params(booking.id),
    );
    expect(await done.json()).toMatchObject({ outcome: "captured", bookingStatus: "captured" });
    const ticked = await tick(post("/api/lab/bookings/tick"));
    expect(ticked.status).toBe(200);
    const [row] = await getDb().select().from(bookings).where(eq(bookings.id, booking.id));
    expect(row.status).toBe("paid_out");

    const sibling = await action(
      post(`/api/lab/bookings/${booking.id}/action`, { action: "no_show" }),
      params(booking.id),
    );
    expect(sibling.status).toBe(409);
    expect(await sibling.json()).toMatchObject({ error: "conflict" });
  });

  it("refuses non-sandbox payer emails, unknown services and foreign bookings", async () => {
    expect(
      (await create(post("/api/lab/bookings", { serviceKey: "drain-cleaning", payerEmail: "a@gmail.com" }))).status,
    ).toBe(400);
    expect(
      (await create(post("/api/lab/bookings", { serviceKey: "nope", payerEmail: "b@x.example.com" }))).status,
    ).toBe(404);
    const ws = await makeWorkspace(getDb());
    const [svc] = await getDb().select().from(services).where(eq(services.workspaceId, ws.id));
    const now = new Date();
    const [slot] = await freeSlots(getDb(), { workspaceId: ws.id, serviceId: svc.id, now });
    const foreign = await createPendingBooking(getDb(), {
      workspaceId: ws.id,
      serviceId: svc.id,
      technicianId: slot.technicianId,
      slotStart: slot.start,
      customer: { name: "x", email: "x@personal.example.com" },
      now,
    });
    expect((await order(post(`/api/lab/bookings/${foreign.id}/order`), params(foreign.id))).status).toBe(404);
  });

  it("answers with the guard's response when the lab is off", async () => {
    guard.denied = new Response(null, { status: 404 });
    expect((await create(post("/api/lab/bookings", {}))).status).toBe(404);
    expect((await tick(post("/api/lab/bookings/tick"))).status).toBe(404);
  });
});

describe("createPendingBooking", () => {
  it("books only a slot it would offer, snapshots the price, and refuses a taken slot", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const [svc] = await db.select().from(services).where(eq(services.workspaceId, ws.id));
    const now = new Date();
    const [slot, second] = await freeSlots(db, { workspaceId: ws.id, serviceId: svc.id, now });
    const input = {
      workspaceId: ws.id,
      serviceId: svc.id,
      technicianId: slot.technicianId,
      slotStart: slot.start,
      customer: { name: "Test", email: "t@personal.example.com" },
      now,
    };
    const booking = await createPendingBooking(db, input);
    expect(booking).toMatchObject({ status: "pending_payment", priceCents: svc.priceCents, slotEnd: slot.end });
    expect(booking.holdExpiresAt.getTime()).toBe(now.getTime() + 60 * 60_000);
    await expect(createPendingBooking(db, input)).rejects.toBeInstanceOf(BookingInputError);
    // The taken slot is no longer offered.
    const after = await freeSlots(db, { workspaceId: ws.id, serviceId: svc.id, now });
    expect(after.map((s) => s.start.getTime())).not.toContain(slot.start.getTime());
    expect(after[0].start.getTime()).toBe(second.start.getTime());
    // A time that isn't on the grid is refused.
    await expect(
      createPendingBooking(db, { ...input, slotStart: new Date(second.start.getTime() + 15 * 60_000) }),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
  });

  it("refuses a technician without the skill and a service of another workspace", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const other = await makeWorkspace(db);
    const svcs = await db.select().from(services).where(eq(services.workspaceId, ws.id));
    const plumbing = svcs.find((s) => s.category === "plumbing")!;
    const electrical = svcs.find((s) => s.category === "electrical")!;
    const now = new Date();
    const [slot] = await freeSlots(db, { workspaceId: ws.id, serviceId: electrical.id, now });
    const base = {
      workspaceId: ws.id,
      technicianId: slot.technicianId, // Luis (electrical)
      slotStart: slot.start,
      customer: { name: "Test", email: "t@personal.example.com" },
      now,
    };
    await expect(createPendingBooking(db, { ...base, serviceId: plumbing.id })).rejects.toMatchObject({
      code: "unknown_technician",
    });
    const [foreignSvc] = await db.select().from(services).where(eq(services.workspaceId, other.id));
    await expect(createPendingBooking(db, { ...base, serviceId: foreignSvc.id })).rejects.toMatchObject({
      code: "unknown_service",
    });
  });
});
