import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as intent } from "@/app/api/try/call/intent/route";
import { POST as fallback } from "@/app/api/try/notify-fallback/route";
import { GET as tryState } from "@/app/api/try/state/route";
import { POST as proxy } from "@/app/api/vapi-proxy/call/web/route";
import { POST as events } from "@/app/api/vapi/events/route";
import { POST as tools } from "@/app/api/vapi/tools/route";
import { closeDb, getDb } from "@/db/client";
import { bookings, callNotifications, calls } from "@/db/schema";
import { notifyCall } from "@/server/agent/notify";
import { purgeExpiredPii } from "@/server/payments/jobs";
import { CALLER_COOKIE, callerCookieValue } from "@/server/try/web-call";
import { WORKSPACE_COOKIE, workspaceCookieValue } from "@/server/workspaces/session";

import { fakeFetch, json } from "../support/fake-fetch";
import { makeWorkspace } from "../support/factory";
import { paymentHarness, payBooking, resetPayments } from "../support/payments";

const SECRET = "w".repeat(40);
const CONTROL_URL = "https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/y/control";

beforeEach(async () => {
  await resetPayments();
  await getDb().execute(sql`truncate rate_counters`);
  // Open web calls of earlier tests would count against the concurrency cap.
  await getDb().execute(sql`update calls set ended_at = now() where ended_at is null`);
  vi.stubEnv("VAPI_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("VAPI_PRIVATE_KEY", "private-key-test");
  vi.stubEnv("VAPI_PUBLIC_KEY", "public-key-test");
  vi.stubEnv("VAPI_ASSISTANT_ID", "asst-holdline");
  vi.stubEnv("DEMO_DAILY_VOICE_MINUTES", "24");
  vi.stubEnv("VAPI_MAX_CALL_SECONDS", "480");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await closeDb();
});

const cookieFor = (wsId: string, caller = true) =>
  [
    `${WORKSPACE_COOKIE}=${workspaceCookieValue(wsId)}`,
    caller
      ? `${CALLER_COOKIE}=${callerCookieValue({ ws: wsId, firstName: "Ada", email: "ada@personal.example.com" })}`
      : "",
  ]
    .filter(Boolean)
    .join("; ");

const browser = (url: string, cookie: string, body: unknown = {}) =>
  new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", host: "localhost:3000", cookie },
    body: JSON.stringify(body),
  });

const webhook = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  handler(
    new Request("http://localhost/api/vapi/x", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify(body),
    }),
  );

function vapiCreates(vapiCallId: string) {
  const fake = fakeFetch([
    {
      match: (r) => r.url === "https://api.vapi.ai/call/web",
      respond: () =>
        json(201, {
          id: vapiCallId,
          type: "webCall",
          status: "queued",
          webCallUrl: "https://vapi.daily.co/room-2",
          monitor: { controlUrl: CONTROL_URL },
          transport: { provider: "daily" },
          assistant: { voice: { provider: "vapi" }, model: { model: "gemini-3.5-flash" } },
        }),
    },
    { match: (r) => r.url === CONTROL_URL, respond: () => json(200, {}) },
  ]);
  vi.stubGlobal("fetch", fake.fetch);
  return fake.calls;
}

const minutesUsed = async () =>
  (
    await getDb().execute<{ n: number }>(
      sql`select coalesce(sum(n), 0)::int as n from rate_counters where scope = 'voice_minutes'`,
    )
  )[0].n;

describe("web calls from /try", () => {
  it("binds the call to the visitor's workspace with the form's details and reserves the minutes", async () => {
    const ws = await makeWorkspace(getDb());
    const vapiCallId = `call-${randomUUID()}`;
    const outbound = vapiCreates(vapiCallId);
    const res = await proxy(browser("/api/vapi-proxy/call/web", cookieFor(ws.id), { assistantId: "attacker" }));
    expect(res.status).toBe(201);
    expect(outbound[0].body).toEqual({
      assistantId: "asst-holdline",
      assistantOverrides: { variableValues: { channel: "web", first_name: "Ada", email: "ada@personal.example.com" } },
    });
    const [row] = await getDb().select().from(calls).where(eq(calls.vapiCallId, vapiCallId));
    expect(row).toMatchObject({
      workspaceId: ws.id,
      lab: false,
      caller: { firstName: "Ada", email: "ada@personal.example.com" },
    });
    expect(await minutesUsed()).toBe(8);

    // The end-of-call report settles the real length (2.5 min → 3) once, even if it arrives twice.
    const report = {
      message: {
        type: "end-of-call-report",
        call: { id: vapiCallId, type: "webCall" },
        endedReason: "customer-ended-call",
        startedAt: "2026-10-22T10:00:00.000Z",
        endedAt: "2026-10-22T10:02:30.000Z",
        artifact: { transcript: "AI: Hi\nUser: Hello", messages: [] },
      },
    };
    expect((await webhook(events, report)).status).toBe(200);
    expect((await webhook(events, report)).status).toBe(200);
    expect(await minutesUsed()).toBe(3);
  });

  it("needs the pre-call form and refuses past the caps without calling Vapi", async () => {
    const ws = await makeWorkspace(getDb());
    const outbound = vapiCreates(`call-${randomUUID()}`);
    expect((await proxy(browser("/api/vapi-proxy/call/web", cookieFor(ws.id, false)))).status).toBe(400);

    // 3 per workspace and day (room for more minutes, so the workspace cap is what refuses).
    vi.stubEnv("DEMO_DAILY_VOICE_MINUTES", "40");
    for (let i = 0; i < 3; i += 1) {
      vapiCreates(`call-${randomUUID()}`);
      expect((await proxy(browser("/api/vapi-proxy/call/web", cookieFor(ws.id)))).status).toBe(201);
      await getDb().update(calls).set({ endedAt: new Date() }).where(eq(calls.workspaceId, ws.id));
    }
    const fourth = await proxy(browser("/api/vapi-proxy/call/web", cookieFor(ws.id)));
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toMatchObject({ error: "voice_busy", reason: "workspace" });

    // The global minute cap: at 24 minutes, the three 8-minute reservations above used it all.
    vi.stubEnv("DEMO_DAILY_VOICE_MINUTES", "24");
    const refusedCalls = vapiCreates(`call-${randomUUID()}`);
    const other = await makeWorkspace(getDb());
    const capped = await proxy(browser("/api/vapi-proxy/call/web", cookieFor(other.id)));
    expect(await capped.json()).toMatchObject({ error: "voice_busy", reason: "minutes" });
    expect(
      (
        await intent(
          browser("/api/try/call/intent", cookieFor(other.id, false), { firstName: "Bo", email: "bo@example.com" }),
        )
      ).status,
    ).toBe(429);
    expect(outbound.filter((c) => c.url === "https://api.vapi.ai/call/web")).toHaveLength(0);
    expect(refusedCalls.filter((c) => c.url === "https://api.vapi.ai/call/web")).toHaveLength(0);
  });

  it("is off without a daily minute budget", async () => {
    vi.stubEnv("DEMO_DAILY_VOICE_MINUTES", "");
    const ws = await makeWorkspace(getDb());
    vapiCreates(`call-${randomUUID()}`);
    expect(await (await proxy(browser("/api/vapi-proxy/call/web", cookieFor(ws.id)))).json()).toMatchObject({
      reason: "off",
    });
  });

  it("sets the caller cookie from the pre-call form", async () => {
    const ws = await makeWorkspace(getDb());
    const res = await intent(
      browser("/api/try/call/intent", cookieFor(ws.id, false), { firstName: "Bo Diddley", email: "BO@example.com" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(
      /^__Host-hl_caller=.+; Path=\/; Max-Age=900; HttpOnly; Secure; SameSite=Strict$/,
    );
  });
});

describe("Vapi tool contract with the real handlers", () => {
  it("answers every toolCallId with a single-line JSON result, in order", async () => {
    const ws = await makeWorkspace(getDb());
    const vapiCallId = `call-${randomUUID()}`;
    await getDb()
      .insert(calls)
      .values({
        workspaceId: ws.id,
        channel: "web",
        vapiCallId,
        status: "in-progress",
        caller: { firstName: "Ada", email: "ada@personal.example.com" },
      });
    const message = (list: { id: string; name: string; args: unknown }[]) => ({
      message: {
        type: "tool-calls",
        call: { id: vapiCallId, type: "webCall" },
        toolCallList: list.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
      },
    });
    const send = async (list: { id: string; name: string; args: unknown }[]) =>
      (
        (await (await webhook(tools, message(list))).json()) as {
          results: { toolCallId: string; result?: string; error?: string }[];
        }
      ).results;

    const [services] = await send([{ id: "t1", name: "get_services", args: { category: "plumbing" } }]);
    const drain = (JSON.parse(services.result!) as { services: { service_id: string; name: string }[] }).services.find(
      (s) => s.name === "Drain cleaning",
    )!;
    const [slots] = await send([
      { id: "t2", name: "check_availability", args: JSON.stringify({ service_id: drain.service_id }) },
    ]);
    const slot = (JSON.parse(slots.result!) as { slots: { slot_id: string }[] }).slots[0];

    const results = await send([
      {
        id: "t3",
        name: "create_booking_with_payment_link",
        args: {
          service_id: drain.service_id,
          slot_id: slot.slot_id,
          customer_name: "Somebody Else",
          customer_email: "other@personal.example.com",
          service_address: "1 Elm St",
          problem_summary: "Drain blocked",
          urgency: "soon",
        },
      },
      { id: "t4", name: "check_payment_status", args: {} },
      { id: "t5", name: "transfer_money", args: {} },
    ]);
    expect(results.map((r) => r.toolCallId)).toEqual(["t3", "t4", "t5"]);
    for (const r of results.slice(0, 2)) expect(r.result).not.toContain("\n");
    expect(JSON.parse(results[0].result!)).toMatchObject({ ok: true, delivery: "screen", hold_amount: "$149.00" });
    expect(JSON.parse(results[1].result!)).toEqual({ status: "waiting" });
    expect(results[2]).toMatchObject({ error: "unknown_tool" });
    // The web form's name and email won over the model's arguments.
    const [booking] = await getDb().select().from(bookings).where(eq(bookings.workspaceId, ws.id));
    expect(booking.priceCents).toBe(14_900);

    // Vapi retries t3: same result, still one booking.
    const [again] = await send([{ id: "t3", name: "create_booking_with_payment_link", args: {} }]);
    expect(JSON.parse(again.result!)).toEqual(JSON.parse(results[0].result!));
    expect(await getDb().$count(bookings, eq(bookings.workspaceId, ws.id))).toBe(1);
  });
});

describe("mid-call confirmation", () => {
  async function authorizedWebBooking() {
    const h = paymentHarness();
    const ws = await makeWorkspace(getDb());
    const vapiCallId = `call-${randomUUID()}`;
    const [call] = await getDb()
      .insert(calls)
      .values({ workspaceId: ws.id, channel: "web", vapiCallId, status: "in-progress", controlUrl: CONTROL_URL })
      .returning();
    const { makeBooking } = await import("../support/factory");
    const booking = await makeBooking(getDb(), ws.id, { now: h.now() });
    await getDb().update(bookings).set({ callId: call.id }).where(eq(bookings.id, booking.id));
    await payBooking(h, booking.id);
    return { ws, call, booking, vapiCallId };
  }

  it("says the fixed sentence through the controlUrl once, then reports it to the page", async () => {
    const { ws, booking, vapiCallId } = await authorizedWebBooking();
    const outbound = vapiCreates("unused");
    expect(await notifyCall(booking.id, "authorized")).toEqual({ sent: true, via: "server", ok: true });
    expect(await notifyCall(booking.id, "authorized")).toEqual({ sent: false, reason: "already_sent" });
    const controls = outbound.filter((c) => c.url === CONTROL_URL);
    expect(controls.map((c) => (c.body as { type: string }).type)).toEqual(["say", "add-message"]);
    expect((controls[0].body as { content: string }).content).toMatch(/^Got it — PayPal confirmed the \$149 hold\./);

    const state = (await (
      await tryState(
        new Request(`http://localhost:3000/api/try/state?vapi=${vapiCallId}`, {
          headers: { cookie: cookieFor(ws.id) },
        }),
      )
    ).json()) as { notify: unknown; booking: { panel: string } };
    expect(state).toMatchObject({
      notify: { status: "authorized", ok: true, via: "server" },
      booking: { panel: "authorized" },
    });
    // The page doesn't speak a second time.
    expect(
      await (await fallback(browser("/api/try/notify-fallback", cookieFor(ws.id), { bookingId: booking.id }))).json(),
    ).toEqual({
      ok: true,
      say: null,
    });
  });

  it("lets the browser speak when the server's say failed, exactly once", async () => {
    const { ws, booking } = await authorizedWebBooking();
    vi.stubGlobal("fetch", fakeFetch([{ match: () => true, respond: () => json(404, {}) }]).fetch);
    expect(await notifyCall(booking.id, "authorized")).toEqual({ sent: true, via: "server", ok: false });
    const first = (await (
      await fallback(browser("/api/try/notify-fallback", cookieFor(ws.id), { bookingId: booking.id }))
    ).json()) as {
      say: string | null;
    };
    expect(first.say).toMatch(/^Got it — PayPal confirmed/);
    const second = (await (
      await fallback(browser("/api/try/notify-fallback", cookieFor(ws.id), { bookingId: booking.id }))
    ).json()) as {
      say: string | null;
    };
    expect(second.say).toBeNull();
    const [row] = await getDb().select().from(callNotifications).where(eq(callNotifications.bookingId, booking.id));
    expect(row).toMatchObject({ via: "browser", ok: true });
  });

  it("never repeats a sentence that was spoken (add-message failed) or may have been (timeout)", async () => {
    for (const second of ["add-message-500", "say-timeout"] as const) {
      const { ws, booking } = await authorizedWebBooking();
      vi.stubGlobal(
        "fetch",
        fakeFetch([
          {
            match: (r) => r.url === CONTROL_URL,
            respond: (r) => {
              const type = (r.body as { type: string }).type;
              if (second === "say-timeout" && type === "say") {
                throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
              }
              return json(type === "say" ? 200 : 500, {});
            },
          },
        ]).fetch,
      );
      const result = await notifyCall(booking.id, "authorized");
      const [row] = await getDb().select().from(callNotifications).where(eq(callNotifications.bookingId, booking.id));
      if (second === "add-message-500") {
        expect(result).toEqual({ sent: true, via: "server", ok: true });
        expect(row.outcome).toBe("spoken");
      } else {
        expect(row.outcome).toBe("unknown");
      }
      const fb = (await (
        await fallback(browser("/api/try/notify-fallback", cookieFor(ws.id), { bookingId: booking.id }))
      ).json()) as { say: string | null };
      expect(fb.say).toBeNull();
    }
  });

  it("lets the browser take over a server claim that never settled", async () => {
    const { ws, booking } = await authorizedWebBooking();
    await getDb()
      .insert(callNotifications)
      .values({
        bookingId: booking.id,
        status: "authorized",
        channel: "web",
        via: "server",
        sentAt: new Date(Date.now() - 1000),
      });
    const fresh = (await (
      await fallback(browser("/api/try/notify-fallback", cookieFor(ws.id), { bookingId: booking.id }))
    ).json()) as { say: string | null };
    expect(fresh.say).toBeNull(); // still within the server's time
    await getDb()
      .update(callNotifications)
      .set({ sentAt: new Date(Date.now() - 30_000) })
      .where(eq(callNotifications.bookingId, booking.id));
    const stuck = (await (
      await fallback(browser("/api/try/notify-fallback", cookieFor(ws.id), { bookingId: booking.id }))
    ).json()) as { say: string | null };
    expect(stuck.say).toMatch(/^Got it/);
  });
});

describe("server and browser never both speak", () => {
  it("skips the server's say when the page took the notice over first", async () => {
    const { booking } = await (async () => {
      const h = paymentHarness();
      const ws = await makeWorkspace(getDb());
      const [call] = await getDb()
        .insert(calls)
        .values({
          workspaceId: ws.id,
          channel: "web",
          vapiCallId: `call-${randomUUID()}`,
          status: "in-progress",
          controlUrl: CONTROL_URL,
        })
        .returning();
      const { makeBooking } = await import("../support/factory");
      const b = await makeBooking(getDb(), ws.id, { now: h.now() });
      await getDb().update(bookings).set({ callId: call.id }).where(eq(bookings.id, b.id));
      await payBooking(h, b.id);
      return { booking: b };
    })();
    const outbound = fakeFetch([
      {
        match: (r) => r.url === CONTROL_URL,
        respond: async () => json(200, {}),
      },
    ]);
    vi.stubGlobal("fetch", outbound.fetch);
    // The page claims the notice between the server's claim and its say.
    const original = notifyCall;
    const takeover = getDb()
      .update(callNotifications)
      .set({ via: "browser", ok: true, outcome: "browser" })
      .where(eq(callNotifications.bookingId, booking.id));
    const claimSpy = vi
      .spyOn(await import("@/server/vapi/notify"), "sendCallNotice")
      .mockImplementation(async (_binding, _notice, stillOurs) => {
        await takeover;
        const ours = await stillOurs?.();
        return { controlUrlSource: "binding", say: null, addMessage: null, skipped: ours === false };
      });
    expect(await original(booking.id, "authorized")).toEqual({ sent: false, reason: "already_sent" });
    claimSpy.mockRestore();
    const [row] = await getDb().select().from(callNotifications).where(eq(callNotifications.bookingId, booking.id));
    expect(row).toMatchObject({ via: "browser", outcome: "browser" });
    expect(outbound.calls).toHaveLength(0);
  });
});

describe("web call reservations", () => {
  it("gives everything back when Vapi never creates the call", async () => {
    const ws = await makeWorkspace(getDb());
    vi.stubGlobal("fetch", fakeFetch([{ match: () => true, respond: () => json(500, { message: "down" }) }]).fetch);
    const before = await getDb().$count(calls, eq(calls.workspaceId, ws.id));
    expect((await proxy(browser("/api/vapi-proxy/call/web", cookieFor(ws.id)))).status).toBe(502);
    expect(await getDb().$count(calls, eq(calls.workspaceId, ws.id))).toBe(before);
    expect(await minutesUsed()).toBe(0);
    const [{ n }] = await getDb().execute<{ n: number }>(
      sql`select coalesce(sum(n), 0)::int as n from rate_counters where scope = 'web_call' and key = ${ws.id}`,
    );
    expect(n).toBe(0);
  });

  it("settles a call that never started to zero minutes", async () => {
    const ws = await makeWorkspace(getDb());
    const vapiCallId = `call-${randomUUID()}`;
    vapiCreates(vapiCallId);
    expect((await proxy(browser("/api/vapi-proxy/call/web", cookieFor(ws.id)))).status).toBe(201);
    expect(await minutesUsed()).toBe(8);
    await webhook(events, {
      message: {
        type: "end-of-call-report",
        call: { id: vapiCallId, type: "webCall" },
        endedReason: "customer-did-not-answer",
        artifact: { transcript: "", messages: [] },
      },
    });
    expect(await minutesUsed()).toBe(0);
  });

  it("holds the line count under concurrent starts", async () => {
    vi.stubEnv("DEMO_DAILY_VOICE_MINUTES", "200");
    const workspaces = await Promise.all(Array.from({ length: 6 }, () => makeWorkspace(getDb())));
    let seq = 0;
    vi.stubGlobal(
      "fetch",
      fakeFetch([
        {
          match: (r) => r.url === "https://api.vapi.ai/call/web",
          respond: () =>
            json(201, {
              id: `call-${randomUUID()}-${(seq += 1)}`,
              type: "webCall",
              status: "queued",
              webCallUrl: "https://vapi.daily.co/room-x",
              transport: { provider: "daily" },
            }),
        },
      ]).fetch,
    );
    const results = await Promise.all(
      workspaces.map((ws) => proxy(browser("/api/vapi-proxy/call/web", cookieFor(ws.id)))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(4);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });
});

describe("retention", () => {
  it("purges the form's name and email and removes dead web-call placeholders", async () => {
    const ws = await makeWorkspace(getDb());
    const old = new Date(Date.now() - 20 * 86_400_000);
    const [chat] = await getDb()
      .insert(calls)
      .values({
        workspaceId: ws.id,
        channel: "chat",
        caller: { firstName: "Ada", email: "ada@personal.example.com" },
        createdAt: old,
      })
      .returning();
    const [placeholder] = await getDb()
      .insert(calls)
      .values({
        workspaceId: ws.id,
        channel: "web",
        status: "creating",
        caller: { firstName: "Bo", email: "bo@x.example.com" },
        createdAt: new Date(Date.now() - 2 * 3_600_000),
      })
      .returning();
    await purgeExpiredPii(getDb(), new Date());
    const [purged] = await getDb().select().from(calls).where(eq(calls.id, chat.id));
    expect(purged.caller).toBeNull();
    expect(await getDb().$count(calls, eq(calls.id, placeholder.id))).toBe(0);
  });
});
