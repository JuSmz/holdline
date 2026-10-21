import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { authorizations, bookingEvents, workspaces } from "@/db/schema";
import { authorizeBooking, createOrderForBooking } from "@/server/payments/authorize";
import { markJobDone } from "@/server/payments/capture";
import { runTick } from "@/server/payments/jobs";
import { cancelBooking } from "@/server/payments/void";
import { processWebhookEvent } from "@/server/payments/webhook-processor";

import { bookingById } from "../support/factory";
import {
  authorizedBooking,
  eventRow,
  paymentHarness,
  pendingBooking,
  resetPayments,
  storeEvent,
} from "../support/payments";

beforeEach(async () => {
  await resetPayments();
});

afterAll(async () => {
  await closeDb();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const db = () => getDb();

async function authRows(bookingId: string) {
  return db().select().from(authorizations).where(eq(authorizations.bookingId, bookingId));
}

describe("SPEC §24 payment matrix: webhooks", () => {
  it("#7 a duplicate webhook, even concurrent, is processed once", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    const eventId = await storeEvent("CHECKOUT.ORDER.APPROVED", { id: orderId }, orderId);
    const results = await Promise.all([
      processWebhookEvent(h.ctx, eventId),
      processWebhookEvent(h.ctx, eventId),
      processWebhookEvent(h.ctx, eventId),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.fake.calls("POST", /\/authorize$/)).toHaveLength(1);
    // A second delivery of the same event (new row ID, same PayPal event) changes nothing either.
    const again = await storeEvent("CHECKOUT.ORDER.APPROVED", { id: orderId }, orderId);
    await processWebhookEvent(h.ctx, again);
    expect(h.fake.calls("POST", /\/authorize$/)).toHaveLength(1);
    const transitions = (await db().select().from(bookingEvents).where(eq(bookingEvents.bookingId, booking.id))).filter(
      (e) => e.toStatus === "authorized",
    );
    expect(transitions).toHaveLength(1);
  });

  it("#8 webhooks out of order reach the same final state", async () => {
    const h = paymentHarness();
    const { booking } = await pendingBooking(h);
    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    // PayPal authorizes (e.g. via onApprove whose response we lost)…
    h.fake.fault("POST", /\/authorize$/, { kind: "lostResponse" }, 3);
    await authorizeBooking(h.ctx, booking.id, orderId);
    const auth = [...h.fake.authorizations.values()][0];
    // …then AUTHORIZATION.CREATED arrives before CHECKOUT.ORDER.APPROVED.
    const created = await storeEvent("PAYMENT.AUTHORIZATION.CREATED", { id: auth.id }, auth.id);
    const approved = await storeEvent("CHECKOUT.ORDER.APPROVED", { id: orderId }, orderId);
    await processWebhookEvent(h.ctx, created);
    await processWebhookEvent(h.ctx, approved);
    expect((await bookingById(db(), booking.id)).status).toBe("authorized");
    expect(await authRows(booking.id)).toHaveLength(1);
    expect(h.fake.authorizations.size).toBe(1);
  });

  it("#19 AUTHORIZATION.VOIDED while authorized → hold_lost → re-approval with a fresh hold", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h);
    const [first] = await authRows(booking.id);
    h.fake.voidExternally(first.paypalAuthorizationId);
    const eventId = await storeEvent(
      "PAYMENT.AUTHORIZATION.VOIDED",
      { id: first.paypalAuthorizationId },
      first.paypalAuthorizationId,
    );
    await processWebhookEvent(h.ctx, eventId);
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "authorized", paymentIssue: "hold_lost" });

    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    expect((await authorizeBooking(h.ctx, booking.id, orderId)).status).toBe("authorized");
    const after = await bookingById(db(), booking.id);
    expect(after).toMatchObject({ status: "authorized", paymentIssue: null });
    const rows = await authRows(booking.id);
    expect(rows.find((r) => r.id === first.id)?.role).toBe("replaced");
    expect(rows.find((r) => r.id === after.activeAuthorizationId)?.role).toBe("active");
    expect((await markJobDone(h.ctx, booking.id)).status).toBe("captured");
  });

  it("#30-adjacent: simulated (lab) events are never processed", async () => {
    const h = paymentHarness();
    const eventId = await storeEvent("CHECKOUT.ORDER.APPROVED", { id: "ORDER-X" }, "ORDER-X");
    await db().execute(`update webhook_events set simulated = true where id = '${eventId}'`);
    await processWebhookEvent(h.ctx, eventId);
    expect(await eventRow(eventId)).toMatchObject({ error: "simulated" });
    expect(h.fake.requests).toHaveLength(0);
  });
});

describe("SPEC §24 payment matrix: reauthorization (#18)", () => {
  it("schedules none for a slot within 3 days", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h, { daysAhead: 1 });
    expect((await authRows(booking.id))[0].reauthorizeAt).toBeNull();
  });

  it("reauthorizes a day-10 job at slot_end − 24 h; capture uses the child, void the parent", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h, { daysAhead: 10 });
    const [parent] = await authRows(booking.id);
    expect(parent.reauthorizeAt?.getTime()).toBe(booking.slotEnd.getTime() - DAY);

    h.advance(9 * DAY); // one tick before: nothing yet
    await runTick(h.ctx, db(), h.now());
    expect(h.fake.calls("POST", /\/reauthorize$/)).toHaveLength(0);
    h.set(new Date(parent.reauthorizeAt!.getTime() + 60_000));
    await runTick(h.ctx, db(), h.now());
    expect(h.fake.calls("POST", /\/reauthorize$/)).toHaveLength(1);
    const after = await bookingById(db(), booking.id);
    const child = (await authRows(booking.id)).find((r) => r.id === after.activeAuthorizationId)!;
    expect(child.parentAuthorizationId).toBe(parent.id);
    // A second tick does not reauthorize again (one per chain).
    await runTick(h.ctx, db(), h.now());
    expect(h.fake.calls("POST", /\/reauthorize$/)).toHaveLength(1);

    await markJobDone(h.ctx, booking.id);
    const [capture] = h.fake.calls("POST", /\/capture$/);
    expect(capture.path).toContain(child.paypalAuthorizationId);
  });

  it("voids the PARENT on a timely cancel after reauthorization", async () => {
    const h = paymentHarness();
    const { ws, booking } = await authorizedBooking(h, { daysAhead: 10 });
    // Reauthorization happens a day before the job, so only a shorter window makes a cancel "timely" then.
    await db()
      .update(workspaces)
      .set({ policy: { cancellationWindowHours: 12 } })
      .where(eq(workspaces.id, ws.id));
    const [parent] = await authRows(booking.id);
    h.set(new Date(parent.reauthorizeAt!.getTime() + 60_000));
    await runTick(h.ctx, db(), h.now());
    expect((await cancelBooking(h.ctx, booking.id)).status).toBe("voided");
    const [voidCall] = h.fake.calls("POST", /\/void$/);
    expect(voidCall.path).toContain(parent.paypalAuthorizationId);
  });

  it("a failed reauthorization sets reauth_failed; re-approval replaces the hold", async () => {
    const h = paymentHarness();
    const { booking } = await authorizedBooking(h, { daysAhead: 10 });
    const [parent] = await authRows(booking.id);
    h.fake.fault("POST", /\/reauthorize$/, { kind: "http", status: 422, issue: "AUTHORIZATION_EXPIRED" });
    h.set(new Date(parent.reauthorizeAt!.getTime() + 60_000));
    await runTick(h.ctx, db(), h.now());
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "authorized", paymentIssue: "reauth_failed" });

    const { orderId } = await createOrderForBooking(h.ctx, booking.id);
    h.fake.approve(orderId);
    await authorizeBooking(h.ctx, booking.id, orderId);
    expect(await bookingById(db(), booking.id)).toMatchObject({ status: "authorized", paymentIssue: null });
    // The replaced chain was voided through the ledger.
    expect(h.fake.authorizations.get(parent.paypalAuthorizationId)?.status).toBe("VOIDED");
  });
});
