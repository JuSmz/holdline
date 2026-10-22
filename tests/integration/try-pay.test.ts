import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as linkMockApprove } from "@/app/api/pay/[token]/mock-approve/route";
import { POST as linkOrder } from "@/app/api/pay/[token]/order/route";
import { POST as dashboardAction } from "@/app/api/dashboard/bookings/[id]/action/route";
import { POST as deviceLink } from "@/app/api/try/bookings/[id]/device-link/route";
import { POST as mockApprove } from "@/app/api/try/bookings/[id]/mock-approve/route";
import { POST as cookieOrder } from "@/app/api/try/bookings/[id]/order/route";
import { closeDb, getDb } from "@/db/client";
import { bookingEvents, bookings, paypalOrders } from "@/db/schema";
import { dashboardState } from "@/server/dashboard/queries";
import { createOrderForBooking } from "@/server/payments/authorize";
import { panelFor } from "@/server/try/state";
import { payLinkBooking, payLinkView } from "@/server/try/pay";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/server/workspaces/session";

import { makeBooking, makeWorkspace } from "../support/factory";
import { paymentHarness, resetPayments } from "../support/payments";

beforeEach(async () => {
  await resetPayments();
  await getDb().execute(sql`truncate rate_counters`);
  // The cookie and token routes use the production context; in tests that is the fake PayPal.
  vi.stubEnv("PAYPAL_MODE", "mock");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await closeDb();
});

const post = (url: string, cookie?: string) =>
  new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
      ...(cookie ? { cookie } : {}),
    },
  });
const cookieFor = (wsId: string) => `${WORKSPACE_COOKIE}=${workspaceCookieValue(wsId)}`;
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) });

async function mintDeviceLink(wsId: string, bookingId: string) {
  const res = await deviceLink(
    post(`/api/try/bookings/${bookingId}/device-link`, cookieFor(wsId)),
    idParams(bookingId),
  );
  return { status: res.status, body: (await res.json()) as { url?: string; expiresAt?: string } };
}

describe("device links", () => {
  it("die once the booking no longer needs the buyer, however it was approved", async () => {
    const ws = await makeWorkspace(getDb());
    const booking = await makeBooking(getDb(), ws.id);
    const { body } = await mintDeviceLink(ws.id, booking.id);
    const token = body.url!.split("/pay/")[1];
    expect(await payLinkBooking(token)).not.toBeNull();
    // Approved on the desktop (cookie route), not through the link.
    const approved = await mockApprove(
      post(`/api/try/bookings/${booking.id}/mock-approve`, cookieFor(ws.id)),
      idParams(booking.id),
    );
    expect(await approved.json()).toMatchObject({ status: "authorized" });
    expect(await payLinkBooking(token)).toBeNull();
  });

  it("last through the authorize grace, and aren't minted after the window closed", async () => {
    const ws = await makeWorkspace(getDb());
    const booking = await makeBooking(getDb(), ws.id);
    const closesAt = new Date(Date.now() + 5 * 60_000);
    await getDb().update(bookings).set({ holdExpiresAt: closesAt }).where(eq(bookings.id, booking.id));
    const { body } = await mintDeviceLink(ws.id, booking.id);
    expect(new Date(body.expiresAt!).getTime()).toBe(closesAt.getTime() + 10 * 60_000);

    await getDb()
      .update(bookings)
      .set({ holdExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(bookings.id, booking.id));
    expect((await mintDeviceLink(ws.id, booking.id)).status).toBe(409);
  });
});

describe("pay-order limits", () => {
  it("count per booking on pay links, so one link holder can't lock a shared workspace", async () => {
    const ws = await makeWorkspace(getDb());
    const a = await makeBooking(getDb(), ws.id);
    const b = await makeBooking(getDb(), ws.id, { daysAhead: 3 });
    const { body } = await mintDeviceLink(ws.id, a.id);
    const token = body.url!.split("/pay/")[1];
    for (let i = 0; i < 10; i += 1) {
      expect((await linkOrder(post(`/api/pay/${token}/order`), tokenParams(token))).status).toBe(200);
    }
    expect((await linkOrder(post(`/api/pay/${token}/order`), tokenParams(token))).status).toBe(429);
    // Another booking of the same workspace is unaffected.
    expect((await cookieOrder(post(`/api/try/bookings/${b.id}/order`, cookieFor(ws.id)), idParams(b.id))).status).toBe(
      200,
    );
  });
});

describe("mock approval", () => {
  it("retires an open order the (restarted) fake PayPal doesn't know and approves a new one", async () => {
    const ws = await makeWorkspace(getDb());
    const booking = await makeBooking(getDb(), ws.id);
    // An order created by another fake instance, as before a mock-server restart.
    const { orderId } = await createOrderForBooking(paymentHarness().ctx, booking.id);
    const res = await mockApprove(
      post(`/api/try/bookings/${booking.id}/mock-approve`, cookieFor(ws.id)),
      idParams(booking.id),
    );
    expect(await res.json()).toMatchObject({ status: "authorized" });
    const [old] = await getDb().select().from(paypalOrders).where(eq(paypalOrders.paypalOrderId, orderId));
    expect(old.status).toBe("VOIDED");
  });
});

describe("pay panel states", () => {
  it("map every booking status to what the customer can still do", async () => {
    const ws = await makeWorkspace(getDb());
    const db = getDb();
    const booking = await makeBooking(db, ws.id);
    const as = async (patch: Partial<typeof bookings.$inferSelect>) => panelFor(db, { ...booking, ...patch });
    expect(await as({})).toBe("waiting");
    expect(await as({ status: "authorized" })).toBe("authorized");
    expect(await as({ status: "authorized", paymentIssue: "hold_lost" })).toBe("reapprove");
    expect(await as({ status: "captured" })).toBe("done");
    expect(await as({ status: "cancelled" })).toBe("cancelled");
    expect(await as({ status: "voided" })).toBe("cancelled");
    expect(await as({ status: "expired" })).toBe("expired");
  });
});

describe("owner dashboard", () => {
  it("gives the cancel dialog what it needs, and refuses when the confirmed rule no longer holds", async () => {
    const ws = await makeWorkspace(getDb());
    const now = new Date();
    const soon = await makeBooking(getDb(), ws.id, { now, slotStart: new Date(now.getTime() + 20 * 3_600_000) });
    await getDb().update(bookings).set({ status: "authorized" }).where(eq(bookings.id, soon.id));
    const later = await makeBooking(getDb(), ws.id, { now, slotStart: new Date(now.getTime() + 30 * 3_600_000) });
    await getDb().update(bookings).set({ status: "authorized" }).where(eq(bookings.id, later.id));
    const data = await dashboardState(getDb(), ws, now);
    expect(data.bookings.find((b) => b.id === soon.id)).toMatchObject({
      slotStart: soon.slotStart.toISOString(),
      cancelWindowHours: 24,
      lateNow: true,
      started: false,
      actions: ["job_done", "no_show", "cancel"],
      noShowFee: "$49.00",
      hold: "$149.00",
    });
    // The rule comes from the server clock, not the visitor's device: it flips once the window is reached.
    expect(data.bookings.find((b) => b.id === later.id)).toMatchObject({ lateNow: false });
    const sevenHoursOn = await dashboardState(getDb(), ws, new Date(now.getTime() + 7 * 3_600_000));
    expect(sevenHoursOn.bookings.find((b) => b.id === later.id)).toMatchObject({ lateNow: true });
    const res = await dashboardAction(
      new Request(`http://localhost:3000/api/dashboard/bookings/${soon.id}/action`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          host: "localhost:3000",
          cookie: cookieFor(ws.id),
        },
        body: JSON.stringify({ action: "cancel", expectLate: false }),
      }),
      idParams(soon.id),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "rule_changed" });
  });
});

describe("pay links after payment", () => {
  it("show the final state read-only once a device link is spent", async () => {
    const ws = await makeWorkspace(getDb());
    const booking = await makeBooking(getDb(), ws.id);
    const { body } = await mintDeviceLink(ws.id, booking.id);
    const token = body.url!.split("/pay/")[1];
    const approved = await linkMockApprove(post(`/api/pay/${token}/mock-approve`), tokenParams(token));
    expect(await approved.json()).toMatchObject({ status: "authorized" });
    const view = await payLinkView(token);
    expect(view).toMatchObject({ live: false });
    expect(await panelFor(getDb(), view!.booking)).toBe("authorized");
    // The routes refuse it.
    expect(await payLinkBooking(token)).toBeNull();
    expect((await linkOrder(post(`/api/pay/${token}/order`), tokenParams(token))).status).toBe(410);
  });

  it("name a late-cancel or no-show fee instead of calling the job done", async () => {
    const ws = await makeWorkspace(getDb());
    const db = getDb();
    const now = new Date();
    const booking = await makeBooking(db, ws.id, { now, slotStart: new Date(now.getTime() + 20 * 3_600_000) });
    await mockApprove(post(`/api/try/bookings/${booking.id}/mock-approve`, cookieFor(ws.id)), idParams(booking.id));
    const cancelled = await dashboardAction(
      new Request(`http://localhost:3000/api/dashboard/bookings/${booking.id}/action`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          host: "localhost:3000",
          cookie: cookieFor(ws.id),
        },
        body: JSON.stringify({ action: "cancel", expectLate: true }),
      }),
      idParams(booking.id),
    );
    expect(await cancelled.json()).toMatchObject({ ok: true, bookingStatus: "captured" });
    const [row] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(await panelFor(db, row)).toBe("late_cancel");
    // Not charged yet: the panel says the fee is being settled, never "charged".
    expect(await panelFor(db, { ...row, status: "no_show" })).toBe("fee_pending");
    expect(await panelFor(db, { ...row, status: "cancelled", cancelReason: "late" })).toBe("fee_pending");
    expect(await panelFor(db, { ...row, status: "cancelled", cancelReason: "owner" })).toBe("cancelled");
    // A no-show without a fee ends voided: "missed", not "cancelled".
    const other = await makeBooking(db, ws.id, { daysAhead: 4 });
    await db
      .insert(bookingEvents)
      .values({ bookingId: other.id, fromStatus: "authorized", toStatus: "no_show", actor: "owner" });
    expect(await panelFor(db, { ...other, status: "voided" })).toBe("missed");
  });
});
