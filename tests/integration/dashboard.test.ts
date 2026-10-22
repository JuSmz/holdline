import { randomUUID } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as bookingDetailRoute } from "@/app/api/dashboard/bookings/[id]/route";
import { POST as dashboardAction } from "@/app/api/dashboard/bookings/[id]/action/route";
import { GET as callDetailRoute } from "@/app/api/dashboard/calls/[id]/route";
import { GET as stateRoute } from "@/app/api/dashboard/state/route";
import { POST as mockApprove } from "@/app/api/try/bookings/[id]/mock-approve/route";
import { MAX_INVOICE_CENTS } from "@/components/dashboard/booking-actions";
import { closeDb, getDb } from "@/db/client";
import { addonItems, bookings, calls, captures, invoices, payouts } from "@/db/schema";
import { seedSampleHistory } from "@/db/seed-data";
import { type AvailabilityFacts, availableActions, runDashboardAction } from "@/server/dashboard/actions";
import { sendBookingPayouts, syncWorkspacePayouts } from "@/server/dashboard/payouts";
import type { DashboardState } from "@/server/dashboard/queries";
import { bookingDetail, dashboardState, voiceLines } from "@/server/dashboard/queries";
import { markJobDone } from "@/server/payments/capture";
import { billExtraWork } from "@/server/payments/invoices";
import { runTick } from "@/server/payments/jobs";
import { processWebhookEvent } from "@/server/payments/webhook-processor";
import { fakePayPal, getPayPalClient } from "@/server/paypal";
import { MAX_INVOICE_TOTAL_CENTS } from "@/server/paypal/invoicing";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/server/workspaces/session";

import { bookingById, makeBooking, makeWorkspace } from "../support/factory";
import { authorizedBooking, paymentHarness, resetPayments, storeEvent } from "../support/payments";

beforeEach(async () => {
  await resetPayments();
  await getDb().execute(sql`truncate rate_counters`);
  // The cookie routes use the production context; in tests that is the process-wide fake PayPal.
  vi.stubEnv("PAYPAL_MODE", "mock");
  vi.stubEnv("PAYPAL_BUSINESS_EMAIL", "merchant@business.example.com");
  fakePayPal().next.payoutItemStatus.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await closeDb();
});

const BASE = "http://localhost:3000";
const cookieFor = (wsId: string) => `${WORKSPACE_COOKIE}=${workspaceCookieValue(wsId)}`;
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

function request(method: "GET" | "POST", url: string, cookie?: string, body?: unknown) {
  return new Request(`${BASE}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      host: "localhost:3000",
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

type StateJson = DashboardState & { ok: boolean };

async function state(wsId: string): Promise<StateJson> {
  const res = await stateRoute(request("GET", "/api/dashboard/state", cookieFor(wsId)));
  expect(res.status).toBe(200);
  return (await res.json()) as StateJson;
}

async function act(wsId: string, bookingId: string, body: unknown) {
  const res = await dashboardAction(
    request("POST", `/api/dashboard/bookings/${bookingId}/action`, cookieFor(wsId), body),
    idParams(bookingId),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A demo booking with an approved hold, through the same cookie route the pay panel uses. */
async function approvedBooking(daysAhead = 3) {
  const db = getDb();
  const ws = await makeWorkspace(db);
  const booking = await makeBooking(db, ws.id, { daysAhead });
  const res = await mockApprove(
    request("POST", `/api/try/bookings/${booking.id}/mock-approve`, cookieFor(ws.id)),
    idParams(booking.id),
  );
  expect(await res.json()).toMatchObject({ status: "authorized" });
  return { ws, booking };
}

const bookingRow = async (id: string) => (await getDb().select().from(bookings).where(eq(bookings.id, id)))[0];

/** With the fake's default SUCCESS, the payout sent after the capture ends the booking paid_out. */
async function paidOut(bookingId: string) {
  await vi.waitFor(async () => expect((await bookingRow(bookingId)).status).toBe("paid_out"), {
    timeout: 5_000,
    interval: 50,
  });
}

/** The payout runs after the response; outside a request scope it starts right away, unawaited. */
async function payoutsSettled(bookingId: string) {
  await vi.waitFor(
    async () => {
      const rows = await getDb().select().from(payouts).where(eq(payouts.bookingId, bookingId));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status !== "pending")).toBe(true);
    },
    { timeout: 5_000, interval: 50 },
  );
}

describe("dashboard state", () => {
  it("is scoped to the cookie's demo copy: another copy sees none of it", async () => {
    const { ws: mine, booking } = await approvedBooking();
    const other = await makeWorkspace(getDb());
    const [call] = await getDb()
      .insert(calls)
      .values({ workspaceId: mine.id, channel: "chat", status: "in-progress", startedAt: new Date(), messages: [] })
      .returning();

    const own = await state(mine.id);
    expect(own.bookings.map((b) => b.id)).toContain(booking.id);
    expect(own.calls.map((c) => c.id)).toContain(call.id);

    const theirs = await state(other.id);
    expect(theirs.bookings).toEqual([]);
    expect(theirs.calls).toEqual([]);
    expect(theirs.ledger).toEqual([]);
    expect(JSON.stringify(theirs)).not.toContain(booking.ref);

    // Details and actions refuse it too, as if it didn't exist.
    const detail = await bookingDetailRoute(
      request("GET", `/api/dashboard/bookings/${booking.id}`, cookieFor(other.id)),
      idParams(booking.id),
    );
    expect(detail.status).toBe(404);
    const callSheet = await callDetailRoute(
      request("GET", `/api/dashboard/calls/${call.id}`, cookieFor(other.id)),
      idParams(call.id),
    );
    expect(callSheet.status).toBe(404);
    expect((await act(other.id, booking.id, { action: "job_done" })).status).toBe(404);
    expect((await bookingRow(booking.id)).status).toBe("authorized");

    // No cookie, no state.
    expect((await stateRoute(request("GET", "/api/dashboard/state"))).status).toBe(401);
  });

  it("never sends tokens, control URLs or addresses", async () => {
    const { ws } = await approvedBooking();
    await getDb().insert(calls).values({
      workspaceId: ws.id,
      channel: "web",
      status: "ended",
      controlUrl: "https://phone-call-websocket.example/secret-control",
      transcript: "AI: Hello!\nUser: Hi, my sink is clogged.",
    });
    const text = JSON.stringify(await state(ws.id));
    expect(text).not.toContain("secret-control");
    expect(text).not.toContain("12 Main St");
    expect(text).not.toContain("buyer@personal.example.com");
  });
});

describe("action availability", () => {
  const facts = (patch: Partial<AvailabilityFacts>): AvailabilityFacts => ({
    status: "authorized",
    flag: null,
    sample: false,
    cancelReason: null,
    slotEnd: new Date(Date.now() + 3_600_000),
    jobDone: false,
    captureInFlight: false,
    anyInFlight: false,
    fallbackInvoice: false,
    retryablePayout: false,
    ...patch,
  });
  const now = new Date();

  it("follows the booking status and its payment flag", () => {
    expect(availableActions(facts({ status: "pending_payment" }), now)).toEqual(["cancel"]);
    expect(availableActions(facts({ status: "pending_payment", flag: "authorization_pending" }), now)).toEqual([]);
    expect(availableActions(facts({}), now)).toEqual(["job_done", "no_show", "cancel"]);
    // A lost hold can't be charged: no Job done / No-show until the customer approves again.
    expect(availableActions(facts({ flag: "hold_lost" }), now)).toEqual(["cancel"]);
    expect(availableActions(facts({ flag: "reauth_failed" }), now)).toEqual(["cancel"]);
    expect(availableActions(facts({ status: "completed" }), now)).toEqual([]);
    expect(availableActions(facts({ status: "completed", flag: "capture_failed" }), now)).toEqual([
      "retry_capture",
      "bill_via_invoice",
    ]);
    expect(
      availableActions(facts({ status: "completed", flag: "capture_failed", fallbackInvoice: true }), now),
    ).toEqual([]);
    expect(
      availableActions(facts({ status: "completed", flag: "capture_failed", captureInFlight: true }), now),
    ).toEqual([]);
    expect(availableActions(facts({ status: "no_show", flag: "capture_failed" }), now)).toEqual([
      "retry_capture",
      "bill_via_invoice",
      "waive_fee",
    ]);
    expect(availableActions(facts({ status: "cancelled", cancelReason: "late", flag: "capture_failed" }), now)).toEqual(
      ["retry_capture", "bill_via_invoice", "waive_fee"],
    );
    expect(availableActions(facts({ status: "cancelled", cancelReason: "owner" }), now)).toEqual(["cancel"]);
    expect(availableActions(facts({ status: "cancelled", cancelReason: "owner", anyInFlight: true }), now)).toEqual([]);
    expect(availableActions(facts({ status: "captured", jobDone: true }), now)).toEqual(["extra_work"]);
    // A no-show fee is no job: no extra work.
    expect(availableActions(facts({ status: "captured" }), now)).toEqual([]);
    expect(availableActions(facts({ status: "captured", flag: "payout_failed", retryablePayout: true }), now)).toEqual([
      "retry_payout",
    ]);
    expect(availableActions(facts({ status: "paid_out", jobDone: true }), now)).toEqual(["extra_work"]);
    const later = new Date(now.getTime() + 15 * 24 * 3_600_000);
    expect(availableActions(facts({ status: "paid_out", jobDone: true }), later)).toEqual([]);
    for (const status of ["voided", "expired"]) expect(availableActions(facts({ status }), now)).toEqual([]);
    expect(availableActions(facts({ sample: true }), now)).toEqual([]);
  });

  it("is computed per booking in the state, and actions run through the payment services", async () => {
    const { ws, booking } = await approvedBooking();
    const before = (await state(ws.id)).bookings.find((b) => b.id === booking.id)!;
    expect(before).toMatchObject({ status: "authorized", actions: ["job_done", "no_show", "cancel"], busy: false });

    const noShow = await act(ws.id, booking.id, { action: "no_show" });
    expect(noShow.body).toMatchObject({ ok: true, bookingStatus: "captured" });
    expect(String(noShow.body.message)).toContain("$49.00");
    await paidOut(booking.id);

    const after = (await state(ws.id)).bookings.find((b) => b.id === booking.id)!;
    expect(after.charged).toEqual({ amount: "$49.00", label: "no-show fee" });
    expect(after.actions).toEqual([]);
    // A sibling click gets the server's message, never a fake success.
    const sibling = await act(ws.id, booking.id, { action: "job_done" });
    expect(sibling.status).toBe(409);
    expect(sibling.body.message).toBe("This booking is already paid out.");
  });
});

describe("money movement", () => {
  it("sends the payout right after the capture, and the poll shows paid_out once PayPal settles", async () => {
    const { ws, booking } = await approvedBooking();
    fakePayPal().next.payoutItemStatus.push("PENDING");

    const done = await act(ws.id, booking.id, { action: "job_done" });
    expect(done.body).toMatchObject({ ok: true, bookingStatus: "captured" });
    expect(String(done.body.message)).toMatch(/Charged \$149\.00\. Maya's payout is on its way\./);

    // Sent without waiting for the tick: the payout leaves `pending` within moments.
    await payoutsSettled(booking.id);
    const [payout] = await getDb().select().from(payouts).where(eq(payouts.bookingId, booking.id));
    expect(payout).toMatchObject({ status: "processing", amountCents: 8_940 });
    expect(payout.paypalItemId).toBeTruthy();
    expect(
      fakePayPal()
        .calls("POST", /^\/v1\/payments\/payouts$/)
        .filter((r) => {
          const header = (r.body as { sender_batch_header?: { sender_batch_id?: string } } | null)?.sender_batch_header;
          return header?.sender_batch_id === payout.senderBatchId;
        }),
    ).toHaveLength(1);

    const processing = await state(ws.id);
    expect(processing.bookings.find((b) => b.id === booking.id)?.status).toBe("captured");
    expect(processing.ledger.some((e) => e.text === "Technician payout sent · Maya · $89.40")).toBe(true);

    // PayPal finishes; a poll in the next slot follows it after its response (one sync per 5 s per
    // workspace), and the poll after that shows it.
    fakePayPal().setPayoutItemStatus(payout.paypalItemId!, "SUCCESS");
    await getDb().execute(sql`truncate rate_counters`);
    await state(ws.id);
    await paidOut(booking.id);
    const settled = await state(ws.id);
    expect(settled.bookings.find((b) => b.id === booking.id)?.status).toBe("paid_out");
    expect(settled.kpis.find((k) => k.key === "payouts")?.value).toBe("$89.40");
  });

  it("answers the poll from the database at once; the PayPal payout sync runs after the response", async () => {
    const { ws, booking } = await approvedBooking();
    fakePayPal().next.payoutItemStatus.push("PENDING");
    await act(ws.id, booking.id, { action: "job_done" });
    await payoutsSettled(booking.id);
    const [payout] = await getDb().select().from(payouts).where(eq(payouts.bookingId, booking.id));
    fakePayPal().setPayoutItemStatus(payout.paypalItemId!, "SUCCESS");
    await getDb().execute(sql`truncate rate_counters`);

    // PayPal hangs on the payout GET until released.
    const client = getPayPalClient();
    const original = client.get.bind(client);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const get = vi.spyOn(client, "get").mockImplementation((async (path: string, options: never) => {
      await held;
      return original(path, options);
    }) as typeof client.get);
    try {
      const res = await Promise.race([
        stateRoute(request("GET", "/api/dashboard/state", cookieFor(ws.id))),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
      ]);
      expect(res, "the poll waited for PayPal").not.toBeNull();
      expect(res!.status).toBe(200);
      const json = (await res!.json()) as StateJson;
      expect(json.bookings.find((b) => b.id === booking.id)?.status).toBe("captured");
      // The sync did start, and is still waiting on PayPal.
      await vi.waitFor(() =>
        expect(get).toHaveBeenCalledWith(expect.stringMatching(/^\/v1\/payments\/payouts\//), expect.anything()),
      );
      expect((await bookingRow(booking.id)).status).toBe("captured");
    } finally {
      release();
    }
    await paidOut(booking.id);
    get.mockRestore();
  });

  it("syncs processing payouts at most once per 5 s per workspace", async () => {
    const h = paymentHarness(new Date("2026-10-22T15:00:01Z"));
    const { ws, booking } = await authorizedBooking(h);
    h.fake.next.payoutItemStatus.push("PENDING");
    await markJobDone(h.ctx, booking.id);
    expect(await sendBookingPayouts(h.ctx, booking.id)).toBe(1);
    const gets = () => h.fake.calls("GET", /^\/v1\/payments\/payouts\//).length;
    const start = gets();

    expect(await syncWorkspacePayouts(h.ctx, ws)).toBe(1);
    expect(await syncWorkspacePayouts(h.ctx, ws)).toBe(0);
    h.advance(1_000);
    expect(await syncWorkspacePayouts(h.ctx, ws)).toBe(0);
    expect(gets()).toBe(start + 1);
    h.advance(5_000);
    expect(await syncWorkspacePayouts(h.ctx, ws)).toBe(1);
    expect(gets()).toBe(start + 2);
    // Sending again is a no-op: the row left `pending`, the ledger key is spent.
    expect(await sendBookingPayouts(h.ctx, booking.id)).toBe(0);
    expect(h.fake.calls("POST", /^\/v1\/payments\/payouts$/)).toHaveLength(1);
  });

  it("bills extra work from the price list through the (fake) PayPal invoice", async () => {
    const { ws, booking } = await approvedBooking();
    await act(ws.id, booking.id, { action: "job_done" });
    await paidOut(booking.id);
    const row = (await state(ws.id)).bookings.find((b) => b.id === booking.id)!;
    expect(row.actions).toEqual(["extra_work"]);

    // Amounts are never accepted from the browser.
    const tampered = await act(ws.id, booking.id, {
      action: "extra_work",
      items: [{ addonKey: "p-trap", quantity: 1, unitPriceCents: 1 }],
      totalCents: 1,
    });
    expect(tampered.status).toBe(200);
    const [first] = await getDb().select().from(invoices).where(eq(invoices.bookingId, booking.id));
    expect(first.totalCents).toBe(3_500);

    const billed = await act(ws.id, booking.id, {
      action: "extra_work",
      items: [
        { addonKey: "shutoff-valve", quantity: 2 },
        { addonKey: "materials-kit", quantity: 1 },
      ],
    });
    expect(billed.body).toMatchObject({ ok: true, invoice: { status: "sent", totalCents: 6_500 } });
    expect(billed.body.message).toBe("Invoice sent · $65.00. The customer gets a PayPal invoice for the extra work.");
    const number = (billed.body.invoice as { number: string }).number;
    const remote = fakePayPal().invoiceByNumber(number);
    expect(remote).toBeTruthy();

    const [stored] = await getDb()
      .select()
      .from(invoices)
      .where(and(eq(invoices.bookingId, booking.id), eq(invoices.invoiceNumber, number)));
    expect(stored).toMatchObject({ kind: "extra_work", status: "sent", totalCents: 6_500 });
    expect(stored.items.map((i) => [i.key, i.quantity, i.unitAmountCents])).toEqual([
      ["shutoff-valve", 2, 2_500],
      ["materials-kit", 1, 1_500],
    ]);

    const detail = await bookingDetailRoute(
      request("GET", `/api/dashboard/bookings/${booking.id}`, cookieFor(ws.id)),
      idParams(booking.id),
    );
    const json = (await detail.json()) as {
      booking: { extra: string };
      payments: { invoices: { number: string; payerViewUrl: string | null; status: string }[] };
      timeline: { text: string }[];
    };
    const sheetInvoice = json.payments.invoices.find((i) => i.number === number)!;
    expect(sheetInvoice).toMatchObject({ status: "Sent" });
    expect(sheetInvoice.payerViewUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect(json.booking.extra).toBe("Extra work invoiced · $100.00");
    expect(json.timeline.map((t) => t.text)).toEqual([
      "PayPal hold approved · $149.00",
      "Marked job done",
      "Charged $149.00",
      "Technician paid out",
      "Extra-work invoice sent · $35.00",
      "Extra-work invoice sent · $65.00",
    ]);

    // Unknown add-ons are refused.
    const unknown = await act(ws.id, booking.id, {
      action: "extra_work",
      items: [{ addonKey: "gold-faucet", quantity: 1 }],
    });
    expect(unknown.status).toBe(400);
  });
});

describe("sample history", () => {
  it("is labelled, has no actions, and refuses every action", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    await seedSampleHistory(db, ws.id, new Date());
    const s = await state(ws.id);
    const samples = s.bookings.filter((b) => b.sample);
    expect(samples).toHaveLength(2);
    expect(samples.every((b) => b.actions.length === 0)).toBe(true);
    expect(s.attention).toEqual([]);
    expect(s.ledger.filter((e) => e.sample).length).toBeGreaterThan(0);
    expect(s.kpis.find((k) => k.key === "revenue")).toMatchObject({ value: "$149.00", sample: "incl. $149.00 sample" });
    expect(s.calls.find((c) => c.sample)).toMatchObject({ title: "Clogged kitchen sink, booked drain cleaning" });

    for (const b of samples) {
      for (const action of ["job_done", "cancel", "waive_fee", "retry_payout"]) {
        const res = await act(ws.id, b.id, {
          action,
          ...(action === "retry_payout" ? { payoutId: randomUUID() } : {}),
        });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: "sample" });
      }
    }
    const paidOut = samples.find((b) => b.status === "paid_out")!;
    const extra = await act(ws.id, paidOut.id, { action: "extra_work", items: [{ addonKey: "p-trap", quantity: 1 }] });
    expect(extra.body).toMatchObject({ error: "sample" });
    expect((await db.select().from(invoices)).length).toBe(0);
  });
});

describe("transcripts", () => {
  it("merge one speaker's consecutive voice lines into one bubble", () => {
    expect(voiceLines("AI: Hello.\nAI: How can I help?\nUser: My sink\nis clogged.\nAI: Got it.")).toEqual([
      { speaker: "agent", text: "Hello. How can I help?" },
      { speaker: "customer", text: "My sink is clogged." },
      { speaker: "agent", text: "Got it." },
    ]);
  });
});

describe("pending bookings", () => {
  it("can be withdrawn, and count as waiting for approval", async () => {
    const { ws } = await approvedBooking(5);
    const pending = await makeBooking(getDb(), ws.id, { daysAhead: 6 });
    const s = await state(ws.id);
    expect(s.bookings.find((b) => b.id === pending.id)).toMatchObject({
      status: "pending_payment",
      actions: ["cancel"],
    });
    expect(s.kpis.find((k) => k.key === "bookings")).toMatchObject({ value: "1", caption: "1 waiting for approval" });
    expect(s.upcoming).toHaveLength(1);

    const withdrawn = await act(ws.id, pending.id, { action: "cancel" });
    expect(withdrawn.body).toMatchObject({ ok: true, bookingStatus: "expired" });
    expect(withdrawn.body.message).toBe("Booking withdrawn. No hold was placed, so nothing was charged.");
  });

  it("never turn a $0.00 withdraw into a late-cancel fee when the customer approves meanwhile", async () => {
    const db = getDb();
    const ws = await makeWorkspace(db);
    const now = new Date();
    // Less than 24 h away: a cancel after approval would be late.
    const soon = await makeBooking(db, ws.id, { now, slotStart: new Date(now.getTime() + 20 * 3_600_000) });
    // The owner opens "Withdraw" ($0.00, no hold)…
    expect((await state(ws.id)).bookings.find((b) => b.id === soon.id)).toMatchObject({
      status: "pending_payment",
      actions: ["cancel"],
      lateNow: true,
    });
    // …the customer approves the hold on another device…
    const approved = await mockApprove(
      request("POST", `/api/try/bookings/${soon.id}/mock-approve`, cookieFor(ws.id)),
      idParams(soon.id),
    );
    expect(await approved.json()).toMatchObject({ status: "authorized" });
    // …and the withdraw (it carries no rule) is refused instead of charging $49.00 nobody confirmed.
    const refused = await act(ws.id, soon.id, { action: "cancel" });
    expect(refused).toEqual({
      status: 409,
      body: {
        ok: false,
        error: "rule_changed",
        message: "The customer just approved the hold. Check the cancellation rule and try again.",
      },
    });
    expect((await bookingRow(soon.id)).status).toBe("authorized");
    expect(await db.select().from(captures).where(eq(captures.bookingId, soon.id))).toEqual([]);

    // While the customer is approving right now, a withdraw waits too.
    const other = await makeBooking(db, ws.id, { daysAhead: 4 });
    await db
      .update(bookings)
      .set({ authorizingUntil: new Date(Date.now() + 60_000) })
      .where(eq(bookings.id, other.id));
    const busy = await act(ws.id, other.id, { action: "cancel" });
    expect(busy).toMatchObject({ status: 409, body: { error: "rule_changed" } });
    expect((await bookingRow(other.id)).status).toBe("pending_payment");

    // With the late rule confirmed in its own dialog, the cancel charges exactly the fee it named.
    const late = await act(ws.id, soon.id, { action: "cancel", expectLate: true });
    expect(late.body).toMatchObject({ ok: true, bookingStatus: "captured" });
    expect(String(late.body.message)).toContain("$49.00");
    await paidOut(soon.id);
  });
});

describe("retry payout", () => {
  it("sends again exactly the payout the dialog named, and keeps the flag while another one still failed", async () => {
    const db = getDb();
    const h = paymentHarness();
    const { ws, booking } = await authorizedBooking(h);
    // The visit payout fails…
    h.fake.next.payoutItemStatus.push("FAILED");
    await markJobDone(h.ctx, booking.id);
    await runTick(h.ctx, db, h.now());
    // …and so does the payout for a paid extra-work invoice, to the same technician.
    const [trap] = await db
      .select()
      .from(addonItems)
      .where(and(eq(addonItems.workspaceId, ws.id), eq(addonItems.key, "p-trap")));
    const invoice = await billExtraWork(h.ctx, booking.id, [{ addonId: trap.id, quantity: 1 }]);
    h.fake.payInvoice(invoice.paypalInvoiceId!);
    h.fake.next.payoutItemStatus.push("FAILED");
    await processWebhookEvent(
      h.ctx,
      await storeEvent("INVOICING.INVOICE.PAID", { id: invoice.paypalInvoiceId }, invoice.paypalInvoiceId!),
    );
    await runTick(h.ctx, db, h.now());
    const all = () =>
      db
        .select()
        .from(payouts)
        .where(eq(payouts.bookingId, booking.id))
        .orderBy(asc(payouts.createdAt), asc(payouts.attemptNo));
    const [visit, extra, ...more] = await all();
    expect(more).toEqual([]);
    expect([visit, extra].map((p) => [p.source, p.status, p.attemptNo])).toEqual([
      ["capture", "failed", 1],
      ["invoice", "failed", 1],
    ]);

    const row = async () => (await dashboardState(db, ws, h.now())).bookings.find((b) => b.id === booking.id)!;
    expect(await row()).toMatchObject({
      status: "captured",
      flag: "payout_failed",
      failedPayout: { id: visit.id, amount: "$89.40", technician: "Maya" },
    });
    expect((await row()).actions).toContain("retry_payout");

    // The click names the extra-work payout: that one, and only that one, is sent again.
    const fresh = await bookingById(db, booking.id);
    const first = await runDashboardAction(h.ctx, ws, fresh, { action: "retry_payout", payoutId: extra.id });
    expect(first).toMatchObject({ ok: true, outcome: "succeeded", bookingStatus: "captured", flag: "payout_failed" });
    const after = await all();
    expect(after.filter((p) => p.source === "capture").map((p) => [p.attemptNo, p.status])).toEqual([[1, "failed"]]);
    expect(after.filter((p) => p.source === "invoice").map((p) => [p.attemptNo, p.status])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
    // The visit payout still waits: the booking stays under Needs attention, and the dialog names it now.
    expect(await row()).toMatchObject({ flag: "payout_failed", failedPayout: { id: visit.id } });
    expect((await dashboardState(db, ws, h.now())).attention).toContainEqual(
      expect.objectContaining({ bookingId: booking.id, flag: "payout_failed" }),
    );
    const detail = await bookingDetail(db, ws, booking.id, h.now());
    expect(detail!.timeline.map((t) => t.text)).toContain("Another technician payout still needs a retry");

    // A payout that isn't the newest failed attempt of this booking is refused, never resent.
    for (const payoutId of [extra.id, randomUUID()]) {
      await expect(runDashboardAction(h.ctx, ws, fresh, { action: "retry_payout", payoutId })).rejects.toMatchObject({
        status: 409,
        code: "payout_not_failed",
      });
    }
    expect(await all()).toHaveLength(3);

    // Retrying the last one clears the flag, and the booking is paid out.
    const last = await runDashboardAction(h.ctx, ws, fresh, { action: "retry_payout", payoutId: visit.id });
    expect(last).toMatchObject({ outcome: "succeeded", bookingStatus: "paid_out", flag: null });
    expect(String(last.message)).toBe("Maya is paid · $89.40.");
  });

  it("needs the payout ID from the dialog", async () => {
    const { ws, booking } = await approvedBooking();
    expect((await act(ws.id, booking.id, { action: "retry_payout" })).status).toBe(400);
  });
});

describe("extra-work invoices", () => {
  it("the picker's cap is the server's cap, and over it the owner reads a sentence, not a code", async () => {
    expect(MAX_INVOICE_CENTS).toBe(MAX_INVOICE_TOTAL_CENTS);
    const { ws, booking } = await approvedBooking();
    await act(ws.id, booking.id, { action: "job_done" });
    await paidOut(booking.id);
    const addons = await getDb().select().from(addonItems).where(eq(addonItems.workspaceId, ws.id));
    // 20 of each add-on: far over $2,000.
    const tooMuch = await act(ws.id, booking.id, {
      action: "extra_work",
      items: addons.slice(0, 6).map((a) => ({ addonKey: a.key, quantity: 20 })),
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.message).toBe(
      "That's more than one invoice can hold ($2,000). Lower a quantity and try again.",
    );
    expect(await getDb().select().from(invoices).where(eq(invoices.bookingId, booking.id))).toEqual([]);
  });
});
