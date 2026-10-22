import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as events } from "@/app/api/vapi/events/route";
import { closeDb, getDb } from "@/db/client";
import {
  authorizations,
  bookings,
  calls,
  captures,
  customers,
  rateCounters,
  vapiEvents,
  webhookEvents,
  workspaces,
} from "@/db/schema";
import { summarizeCall } from "@/server/agent/summary";
import { type ChatDeps, runChatTurn } from "@/server/chat/runtime";
import { startChat } from "@/server/chat/session";
import { appendChat } from "@/server/chat/transcript";
import { GeminiClient } from "@/server/gemini/client";
import { FakeGemini } from "@/server/gemini/mock/fake-gemini";
import { authorizeBooking, createOrderForBooking } from "@/server/payments/authorize";
import { markNoShow } from "@/server/payments/capture";
import { purgeExpiredPii, runTick } from "@/server/payments/jobs";
import { tryApiGuard } from "@/server/workspaces/guard";
import { endDemoWorkspaceCalls, purgeDemoWorkspacePii, releaseDemoWorkspaceHolds } from "@/server/workspaces/reset";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/server/workspaces/session";

import { fakeFetch, json } from "../support/fake-fetch";
import { bookingById, makeBooking, makeWorkspace } from "../support/factory";
import {
  type Harness,
  paymentHarness,
  payBooking,
  pendingBooking,
  resetPayments,
  storeEvent,
} from "../support/payments";

const SECRET = "r".repeat(40);
const CONTROL_URL = "https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/z/control";
const DAY = 24 * 3_600_000;
const db = () => getDb();

let h: Harness;
let gemini: FakeGemini;
let deps: ChatDeps;

beforeEach(async () => {
  await resetPayments();
  h = paymentHarness();
  gemini = new FakeGemini();
  deps = {
    ctx: h.ctx,
    gemini: new GeminiClient({ apiKey: "test", fetch: gemini.fetch, sleep: async () => {} }),
    model: "gemini-3.8-flash",
    dailyBudgetCents: 100,
  };
  vi.stubEnv("VAPI_WEBHOOK_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await closeDb();
});

const reload = async (id: string) => (await db().select().from(calls).where(eq(calls.id, id)))[0];
const workspaceRow = async (id: string) => (await db().select().from(workspaces).where(eq(workspaces.id, id)))[0];

const vapiWebhook = (body: unknown) =>
  events(
    new Request("http://localhost/api/vapi/events", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    }),
  );

/** A demo copy with one web call, a booking of that call, and a stored Vapi payload, all with PII. */
async function copyWithCall() {
  const ws = await makeWorkspace(db());
  const vapiCallId = `call-${randomUUID()}`;
  const [call] = await db()
    .insert(calls)
    .values({
      workspaceId: ws.id,
      channel: "web",
      vapiCallId,
      status: "in-progress",
      controlUrl: CONTROL_URL,
      caller: { firstName: "Ada", email: "ada@personal.example.com" },
      transcript: "User: I'm Ada at 12 Main St",
    })
    .returning();
  const booking = await makeBooking(db(), ws.id, { now: h.now() });
  await db()
    .update(bookings)
    .set({ problemSummary: "Ada's sink at 12 Main St", callId: call.id })
    .where(eq(bookings.id, booking.id));
  await db()
    .insert(vapiEvents)
    .values({
      endpoint: "events",
      messageType: "status-update",
      vapiCallId,
      payload: { transcript: "User: I'm Ada" },
    });
  return { ws, call, booking, vapiCallId };
}

const eventsOf = (vapiCallId: string) => db().select().from(vapiEvents).where(eq(vapiEvents.vapiCallId, vapiCallId));

describe("Start a fresh demo: the PII purge and the reset fence", () => {
  it("purges the copy, marks it reset, and keeps a late end-of-call report's transcript out", async () => {
    const { ws, call, booking, vapiCallId } = await copyWithCall();

    expect(await purgeDemoWorkspacePii(db(), ws.id, h.now())).toBe(true);
    expect((await workspaceRow(ws.id)).resetAt).toEqual(h.now());
    expect(await reload(call.id)).toMatchObject({ transcript: null, caller: null, messages: null });
    expect(await bookingById(db(), booking.id)).toMatchObject({ problemSummary: null });
    const [customer] = await db().select().from(customers).where(eq(customers.id, booking.customerId!));
    expect(customer).toMatchObject({ name: null, email: null, address: null });
    expect(await eventsOf(vapiCallId)).toHaveLength(0);

    // Vapi's report arrives after the reset: the numbers land, the transcript and the payload don't.
    const report = {
      message: {
        type: "end-of-call-report",
        call: { id: vapiCallId, type: "webCall" },
        endedReason: "customer-ended-call",
        startedAt: "2026-10-22T10:00:00.000Z",
        endedAt: "2026-10-22T10:02:30.000Z",
        artifact: { transcript: "User: I'm Ada at 12 Main St", messages: [{ role: "user", message: "I'm Ada" }] },
      },
    };
    expect((await vapiWebhook(report)).status).toBe(200);
    expect(await reload(call.id)).toMatchObject({
      status: "ended",
      endedReason: "customer-ended-call",
      durationS: 150,
      transcript: null,
      messages: null,
      summary: null,
    });
    expect(await eventsOf(vapiCallId)).toHaveLength(0);

    // A repeat of the purge (the tick's backstop) is harmless and keeps the first reset time.
    expect(await purgeDemoWorkspacePii(db(), ws.id, new Date(h.now().getTime() + 60_000))).toBe(true);
    expect((await workspaceRow(ws.id)).resetAt).toEqual(h.now());
  });

  it("never purges the main workspace", async () => {
    const [main] = await db().select().from(workspaces).where(eq(workspaces.kind, "main"));
    expect(await purgeDemoWorkspacePii(db(), main.id, h.now())).toBe(false);
    expect((await workspaceRow(main.id)).resetAt).toBeNull();
  });

  it("the guard treats a reset copy as gone", async () => {
    const ws = await makeWorkspace(db());
    const request = () =>
      new Request("http://localhost:3000/api/try/state", {
        headers: { cookie: `${WORKSPACE_COOKIE}=${workspaceCookieValue(ws.id)}` },
      });
    const before = await tryApiGuard(request());
    expect(before).not.toBeInstanceOf(Response);

    await purgeDemoWorkspacePii(db(), ws.id, h.now());
    const after = await tryApiGuard(request());
    expect(after).toBeInstanceOf(Response);
    expect((after as Response).status).toBe(401);
    expect(await (after as Response).json()).toMatchObject({ error: "no_demo_workspace" });
  });

  it("a chat turn and a summary still running at the reset keep nothing", async () => {
    const ws = await makeWorkspace(db());
    const chat = await startChat(db(), {
      workspaceId: ws.id,
      firstName: "Ada",
      email: "ada@personal.example.com",
      now: h.now(),
    });
    // The visitor resets while the model is answering the first message.
    let purged = false;
    gemini.onRequest = async () => {
      if (purged) return;
      purged = true;
      await purgeDemoWorkspacePii(db(), ws.id, h.now());
    };
    expect(await runChatTurn(deps, chat, "My sink at 12 Main St is blocked")).toMatchObject({
      ok: false,
      reason: "unavailable",
      message: expect.stringMatching(/reset/),
    });
    expect(await reload(chat.id)).toMatchObject({ messages: null, geminiContents: null, caller: null });
    // A payment confirmation arriving later appends nothing either.
    expect(
      await appendChat(db(), chat.id, {
        lines: [{ role: "assistant", text: "Confirmed.", at: h.now().toISOString() }],
      }),
    ).toBe(false);
    expect((await reload(chat.id)).messages).toBeNull();

    // A summary whose model call is running when the copy is reset stores nothing.
    const other = await makeWorkspace(db());
    const second = await startChat(db(), {
      workspaceId: other.id,
      firstName: "Bo",
      email: "bo@personal.example.com",
      now: h.now(),
    });
    expect(
      await appendChat(db(), second.id, {
        lines: [
          { role: "user", text: "My kitchen drain at 4 Oak Ave is blocked", at: h.now().toISOString() },
          { role: "assistant", text: "Drain cleaning is $149.00.", at: h.now().toISOString() },
        ],
      }),
    ).toBe(true);
    const summaryDeps = {
      db: db(),
      gemini: deps.gemini,
      model: "gemini-3.1-flash-lite",
      dailyBudgetCents: 100,
      now: h.now,
    };
    gemini.onRequest = async () => {
      await purgeDemoWorkspacePii(db(), other.id, h.now());
    };
    expect(await summarizeCall(summaryDeps, second.id)).toBeNull();
    expect(await reload(second.id)).toMatchObject({ summary: null, messages: null });
    // After the reset no model call is made at all.
    const requests = gemini.requests.length;
    expect(await summarizeCall(summaryDeps, second.id)).toBeNull();
    expect(gemini.requests.length).toBe(requests);
  });

  it("ends a live web call of the copy through its controlUrl", async () => {
    const { ws } = await copyWithCall();
    await db()
      .insert(calls)
      .values({
        workspaceId: ws.id,
        channel: "web",
        vapiCallId: `call-${randomUUID()}`,
        status: "ended",
        endedAt: h.now(),
        controlUrl: `${CONTROL_URL}-ended`,
      });
    const fake = fakeFetch([{ match: (r) => r.url === CONTROL_URL, respond: () => json(200, {}) }]);
    vi.stubGlobal("fetch", fake.fetch);
    expect(await endDemoWorkspaceCalls(db(), ws.id)).toBe(1);
    expect(fake.calls).toMatchObject([{ method: "POST", url: CONTROL_URL, body: { type: "end-call" } }]);
  });

  it("clears the processed PayPal webhook payloads of the copy's resources", async () => {
    const { ws, booking, orderId } = await authorizedViaPending(h);
    const [auth] = await db().select().from(authorizations).where(eq(authorizations.bookingId, booking.id));
    const payer = { payer: { email_address: "ada@personal.example.com" } };
    const processed = await storeEvent("CHECKOUT.ORDER.APPROVED", payer, orderId);
    const pending = await storeEvent("PAYMENT.AUTHORIZATION.CREATED", payer, auth.paypalAuthorizationId);
    const unrelated = await storeEvent("CHECKOUT.ORDER.APPROVED", payer, `ORDER-${randomUUID()}`);
    await db()
      .update(webhookEvents)
      .set({ processedAt: h.now() })
      .where(inArray(webhookEvents.id, [processed, unrelated]));

    await purgeDemoWorkspacePii(db(), ws.id, h.now());
    const rows = await db()
      .select({ id: webhookEvents.id, raw: webhookEvents.raw })
      .from(webhookEvents)
      .where(inArray(webhookEvents.id, [processed, pending, unrelated]));
    const raw = (id: string) => rows.find((r) => r.id === id)?.raw;
    expect(raw(processed)).toEqual({});
    // Not yet applied: it keeps its payload until it is (the retention job clears it later).
    expect(raw(pending)).toMatchObject({ resource: payer });
    expect(raw(unrelated)).toMatchObject({ resource: payer });
  });
});

/** A pending booking in a fresh copy, authorized: returns the copy too. */
async function authorizedViaPending(harness: Harness) {
  const { ws, booking } = await pendingBooking(harness, { daysAhead: 3 });
  const { orderId, outcome } = await payBooking(harness, booking.id);
  if (outcome.status !== "authorized") throw new Error(`expected authorized, got ${outcome.status}`);
  return { ws, booking: outcome.booking, orderId };
}

describe("Start a fresh demo: holds", () => {
  it("releases every open hold without a fee, including a failed fee and one approved during the reset", async () => {
    const { ws, booking: held } = await authorizedViaPending(h);
    // A no-show whose fee capture was declined still holds the buyer's money.
    const noShow = await makeBooking(db(), ws.id, { now: h.now(), daysAhead: 4 });
    expect((await payBooking(h, noShow.id)).outcome.status).toBe("authorized");
    h.fake.next.captureStatus.push("DECLINED");
    expect((await markNoShow(h.ctx, noShow.id)).status).toBe("capture_failed");
    // The visitor is approving a third one in the PayPal popup right when they reset.
    const approving = await makeBooking(db(), ws.id, { now: h.now(), daysAhead: 5 });
    const { orderId } = await createOrderForBooking(h.ctx, approving.id);
    h.fake.approve(orderId);
    await db()
      .update(bookings)
      .set({ authorizingUntil: new Date(h.now().getTime() + 2 * 60_000) })
      .where(eq(bookings.id, approving.id));

    await purgeDemoWorkspacePii(db(), ws.id, h.now());
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await releaseDemoWorkspaceHolds(h.ctx, ws.id)).toBe(2);
    expect(await bookingById(db(), held.id)).toMatchObject({ status: "voided" });
    expect(await bookingById(db(), noShow.id)).toMatchObject({ status: "voided", paymentIssue: null });
    expect(await bookingById(db(), approving.id)).toMatchObject({ status: "pending_payment" });

    // The authorize finishes after the reset; the next tick releases that hold too.
    expect((await authorizeBooking(h.ctx, approving.id, orderId)).status).toBe("authorized");
    h.advance(5 * 60_000);
    const report = await runTick(h.ctx, db(), h.now());
    expect(report.reset_holds).toBeGreaterThanOrEqual(1);
    expect(await bookingById(db(), approving.id)).toMatchObject({ status: "voided" });

    expect(h.fake.calls("POST", /\/void$/)).toHaveLength(3);
    const charged = await db()
      .select()
      .from(captures)
      .where(and(inArray(captures.bookingId, [held.id, noShow.id, approving.id]), eq(captures.status, "COMPLETED")));
    expect(charged).toHaveLength(0);
  });
});

describe("retention", () => {
  it("clears problem summaries after 14 days and deletes expired rate counters", async () => {
    const ws = await makeWorkspace(db());
    const old = await makeBooking(db(), ws.id, { now: h.now(), daysAhead: 2 });
    const recent = await makeBooking(db(), ws.id, { now: h.now(), daysAhead: 3 });
    const sample = await makeBooking(db(), ws.id, { now: h.now(), daysAhead: 4 });
    const longAgo = new Date(h.now().getTime() - 15 * DAY);
    await db()
      .update(bookings)
      .set({ problemSummary: "Ada's sink at 12 Main St", createdAt: longAgo })
      .where(eq(bookings.id, old.id));
    await db().update(bookings).set({ problemSummary: "Bo's outlet" }).where(eq(bookings.id, recent.id));
    await db()
      .update(bookings)
      .set({ problemSummary: "Sample text", createdAt: longAgo, sample: true })
      .where(eq(bookings.id, sample.id));

    const key = randomUUID();
    await db()
      .insert(rateCounters)
      .values([
        { scope: "reset-test", key, window: "expired", n: 1, expiresAt: new Date(h.now().getTime() - 60_000) },
        { scope: "reset-test", key, window: "live", n: 1, expiresAt: new Date(h.now().getTime() + 60_000) },
      ]);

    await purgeExpiredPii(db(), h.now());
    expect(await bookingById(db(), old.id)).toMatchObject({ problemSummary: null });
    expect(await bookingById(db(), recent.id)).toMatchObject({ problemSummary: "Bo's outlet" });
    expect(await bookingById(db(), sample.id)).toMatchObject({ problemSummary: "Sample text" });
    const counters = await db()
      .select({ window: rateCounters.window })
      .from(rateCounters)
      .where(and(eq(rateCounters.scope, "reset-test"), eq(rateCounters.key, key)));
    expect(counters).toEqual([{ window: "live" }]);
  });
});
