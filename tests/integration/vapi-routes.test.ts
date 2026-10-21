import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as notify } from "@/app/api/lab/voice/notify/route";
import { POST as proxy } from "@/app/api/vapi-proxy/call/web/route";
import { POST as events } from "@/app/api/vapi/events/route";
import { POST as tools } from "@/app/api/vapi/tools/route";
import { closeDb, getDb } from "@/db/client";
import { calls, vapiEvents } from "@/db/schema";
import { MAIN_WORKSPACE_ID } from "@/db/seed";

import { fakeFetch, json, type Recorded } from "../support/fake-fetch";

// The lab guard reads Next's request cookies; its own behaviour is covered by the PayPal lab.
const guard = vi.hoisted(() => ({ denied: null as Response | null }));
vi.mock("@/server/lab", () => ({
  labApiGuard: async () => guard.denied,
  labAccess: async () => "ok",
}));

const SECRET = "w".repeat(40);
const CONTROL_URL = "https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/x/control";

beforeEach(() => {
  vi.stubEnv("VAPI_WEBHOOK_SECRET", SECRET);
  guard.denied = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await closeDb();
});

function webhook(handler: (r: Request) => Promise<Response>, body: unknown, headers: Record<string, string> = {}) {
  return handler(
    new Request("http://localhost/api/vapi/x", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function bindCall(values: Partial<typeof calls.$inferInsert> = {}) {
  const vapiCallId = `call-${randomUUID()}`;
  await getDb()
    .insert(calls)
    .values({ workspaceId: MAIN_WORKSPACE_ID, channel: "web", vapiCallId, lab: true, status: "queued", ...values });
  return vapiCallId;
}

async function callRow(vapiCallId: string) {
  const [row] = await getDb().select().from(calls).where(eq(calls.vapiCallId, vapiCallId));
  return row;
}

async function eventsFor(vapiCallId: string) {
  return getDb().select().from(vapiEvents).where(eq(vapiEvents.vapiCallId, vapiCallId));
}

/** Stubs fetch for outbound control-URL and Vapi API requests. */
function stubFetch(routes: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(routes);
  vi.stubGlobal("fetch", fake.fetch);
  return fake.calls;
}

const toolCalls = (vapiCallId: string, controlUrl = CONTROL_URL) => ({
  message: {
    type: "tool-calls",
    call: { id: vapiCallId, type: "webCall", monitor: { controlUrl } },
    toolCallList: [
      { id: "tc-1", type: "function", function: { name: "get_services", arguments: '{"category":"plumbing"}' } },
      { id: "tc-2", type: "function", function: { name: "book_everything", arguments: "{}" } },
    ],
  },
});

describe("Vapi webhook auth", () => {
  it.each([
    ["events", events],
    ["tools", tools],
  ])("%s: 503 without a secret, 401 with a wrong token, 413 too large, 400 not JSON", async (_name, handler) => {
    expect((await webhook(handler, "{}", { authorization: "Bearer nope" })).status).toBe(401);
    expect((await webhook(handler, "{}", { authorization: "" })).status).toBe(401);
    expect((await webhook(handler, "x".repeat(300 * 1024))).status).toBe(413);
    expect((await webhook(handler, "{not json")).status).toBe(400);
    expect((await webhook(handler, { type: "status-update" })).status).toBe(400);
    vi.stubEnv("VAPI_WEBHOOK_SECRET", "too-short");
    expect((await webhook(handler, "{}")).status).toBe(503);
  });
});

describe("POST /api/vapi/tools", () => {
  it("answers each tool call of a bound call and keeps redacted fixtures", async () => {
    const vapiCallId = await bindCall();
    const res = await webhook(tools, toolCalls(vapiCallId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { toolCallId: string; result?: string; error?: string }[] };
    expect(body.results.map((r) => r.toolCallId)).toEqual(["tc-1", "tc-2"]);
    const services = JSON.parse(body.results[0].result ?? "{}") as { services: { service_id: string }[] };
    expect(services.services.map((s) => s.service_id)).toEqual(["lab-drain", "lab-diagnostic"]);
    expect(body.results[1]).toMatchObject({ error: "unknown_tool" });

    const stored = await eventsFor(vapiCallId);
    expect(stored.map((e) => e.messageType).sort()).toEqual(["tool-calls", "tool-calls.response"]);
    expect(JSON.stringify(stored)).not.toContain(CONTROL_URL);
  });

  it("refuses tools on a call we didn't create and ends it", async () => {
    const outbound = stubFetch([{ match: (r) => r.url === CONTROL_URL, respond: () => json(200, {}) }]);
    const res = await webhook(tools, toolCalls(`call-${randomUUID()}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { error?: string }[] };
    expect(body.results.every((r) => r.error === "call_not_bound")).toBe(true);
    expect(outbound).toEqual([expect.objectContaining({ url: CONTROL_URL, body: { type: "end-call" } })]);
  });
});

describe("POST /api/vapi/events", () => {
  const status = (vapiCallId: string, value: string) => ({
    message: {
      type: "status-update",
      status: value,
      call: { id: vapiCallId, type: "webCall", monitor: { controlUrl: CONTROL_URL } },
    },
  });

  it("tracks status, remembers the controlUrl, and never leaves `ended`", async () => {
    const vapiCallId = await bindCall();
    await webhook(events, status(vapiCallId, "in-progress"));
    let row = await callRow(vapiCallId);
    expect(row).toMatchObject({ status: "in-progress", controlUrl: CONTROL_URL });
    expect(row.startedAt).toBeInstanceOf(Date);

    await webhook(events, status(vapiCallId, "ended"));
    await webhook(events, status(vapiCallId, "in-progress")); // late, out-of-order delivery
    row = await callRow(vapiCallId);
    expect(row.status).toBe("ended");
    expect(row.endedAt).toBeInstanceOf(Date);
  });

  it("ends an in-progress call that has no binding", async () => {
    const outbound = stubFetch([{ match: (r) => r.url === CONTROL_URL, respond: () => json(200, {}) }]);
    const res = await webhook(events, status(`call-${randomUUID()}`, "in-progress"));
    expect(res.status).toBe(200);
    expect(outbound.map((r: Recorded) => r.body)).toEqual([{ type: "end-call" }]);
  });

  it("stores the end-of-call report", async () => {
    const vapiCallId = await bindCall({ status: "in-progress" });
    await webhook(events, {
      message: {
        type: "end-of-call-report",
        call: { id: vapiCallId, type: "webCall" },
        endedReason: "customer-ended-call",
        cost: 0.42,
        startedAt: "2026-10-21T18:00:00.000Z",
        endedAt: "2026-10-21T18:02:30.000Z",
        artifact: {
          transcript: "AI: Hi",
          messages: [{ role: "bot", message: "Hi" }],
          performanceMetrics: { turnLatencies: [{ turnLatency: 1200 }] },
        },
      },
    });
    expect(await callRow(vapiCallId)).toMatchObject({
      status: "ended",
      endedReason: "customer-ended-call",
      costCents: 42,
      durationS: 150,
      transcript: "AI: Hi",
      metrics: { turnLatencies: [{ turnLatency: 1200 }] },
    });
  });

  it("answers tool calls that arrive here instead of the tool URL", async () => {
    const vapiCallId = await bindCall();
    const body = (await (await webhook(events, toolCalls(vapiCallId))).json()) as { results: unknown[] };
    expect(body.results).toHaveLength(2);
  });
});

describe("POST /api/vapi-proxy/call/web", () => {
  const proxyRequest = () =>
    new Request("http://localhost:3000/api/vapi-proxy/call/web", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer proxy", origin: "http://localhost:3000" },
      body: JSON.stringify({ assistantId: "attacker-assistant", assistant: { model: { model: "expensive" } } }),
    });

  beforeEach(() => {
    vi.stubEnv("VAPI_PRIVATE_KEY", "private-key-test");
    vi.stubEnv("VAPI_PUBLIC_KEY", "public-key-test");
    vi.stubEnv("VAPI_ASSISTANT_ID", "asst-holdline");
  });

  it("discards the client body, creates the call with the server-only public key, binds it and hides the controlUrl", async () => {
    const vapiCallId = `call-${randomUUID()}`;
    const outbound = stubFetch([
      {
        match: (r) => r.url === "https://api.vapi.ai/call/web",
        respond: () =>
          json(201, {
            id: vapiCallId,
            type: "webCall",
            status: "queued",
            webCallUrl: "https://vapi.daily.co/room-1",
            monitor: { controlUrl: CONTROL_URL, listenUrl: "wss://x.vapi.ai/listen" },
            transport: { provider: "daily" },
            assistant: { voice: { provider: "vapi" }, model: { model: "gemini-3.5-flash", messages: [] } },
          }),
      },
    ]);

    const res = await proxy(proxyRequest());
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: vapiCallId,
      webCallUrl: "https://vapi.daily.co/room-1",
      transport: { provider: "daily" },
      artifactPlan: { videoRecordingEnabled: false },
      assistant: { voice: { provider: "vapi" } },
    });

    expect(outbound).toHaveLength(1);
    // /call/web rejects the private key; the public key stays on the server and never appears in the response.
    expect(outbound[0].headers.Authorization).toBe("Bearer public-key-test");
    expect(JSON.stringify(body)).not.toContain("public-key-test");
    expect(outbound[0].body).toEqual({
      assistantId: "asst-holdline",
      assistantOverrides: { variableValues: { channel: "web", first_name: "Lab", email: "lab-caller@example.com" } },
    });

    expect(await callRow(vapiCallId)).toMatchObject({
      workspaceId: MAIN_WORKSPACE_ID,
      channel: "web",
      lab: true,
      vapiCallType: "webCall",
      controlUrl: CONTROL_URL,
      llmModel: "gemini-3.5-flash",
    });
    const [fixture] = await eventsFor(vapiCallId);
    expect(fixture.messageType).toBe("call.web.created");
    expect(JSON.stringify(fixture.payload)).not.toContain(CONTROL_URL);
  });

  it("answers with the guard's response when lab access is missing", async () => {
    guard.denied = new Response(null, { status: 404 });
    const outbound = stubFetch([]);
    expect((await proxy(proxyRequest())).status).toBe(404);
    expect(outbound).toHaveLength(0);
  });

  it("reports Vapi errors as 502 and stores no binding", async () => {
    const before = await getDb().$count(calls);
    stubFetch([{ match: () => true, respond: () => json(400, { message: ["assistantId must be a UUID"] }) }]);
    const res = await proxy(proxyRequest());
    expect(res.status).toBe(502);
    expect(await getDb().$count(calls)).toBe(before);
    expect(await res.json()).toMatchObject({ error: "vapi_error", status: 400, detail: "assistantId must be a UUID" });
  });

  it("is 503 until the assistant and the public key are configured", async () => {
    const outbound = stubFetch([]);
    vi.stubEnv("VAPI_ASSISTANT_ID", "");
    expect((await proxy(proxyRequest())).status).toBe(503);
    vi.stubEnv("VAPI_ASSISTANT_ID", "asst-holdline");
    vi.stubEnv("VAPI_PUBLIC_KEY", "");
    const res = await proxy(proxyRequest());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("VAPI_PUBLIC_KEY") });
    expect(outbound).toHaveLength(0);
  });
});

describe("POST /api/lab/voice/notify", () => {
  const notifyRequest = (callId: string, notice = "authorized") =>
    new Request("http://localhost:3000/api/lab/voice/notify", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ callId, notice }),
    });

  it("says the fixed sentence, then adds the system note, through the stored controlUrl", async () => {
    const vapiCallId = await bindCall({ controlUrl: CONTROL_URL, status: "in-progress" });
    const outbound = stubFetch([{ match: (r) => r.url === CONTROL_URL, respond: () => json(200, {}) }]);
    const res = await notify(notifyRequest(vapiCallId));
    expect(await res.json()).toMatchObject({ ok: true, controlUrlSource: "binding" });
    expect(outbound.map((r) => (r.body as { type: string }).type)).toEqual(["say", "add-message"]);
    expect(outbound[0].body).toMatchObject({ content: expect.stringContaining("PayPal confirmed the $149 hold") });
    expect(outbound[1].body).toEqual({
      type: "add-message",
      message: { role: "system", content: "[payment-update] HL-LAB01 authorized; the caller has been told." },
      triggerResponseEnabled: false,
    });
  });

  it("is not ok when add-message fails, and sends no add-message when say fails", async () => {
    const vapiCallId = await bindCall({ controlUrl: CONTROL_URL, status: "in-progress" });
    let outbound = stubFetch([
      {
        match: (r) => r.url === CONTROL_URL,
        respond: (r) => json((r.body as { type: string }).type === "say" ? 200 : 500, {}),
      },
    ]);
    let body = (await (await notify(notifyRequest(vapiCallId))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, say: { ok: true }, addMessage: { ok: false, status: 500 } });
    expect(outbound).toHaveLength(2);

    outbound = stubFetch([{ match: (r) => r.url === CONTROL_URL, respond: () => json(500, {}) }]);
    body = (await (await notify(notifyRequest(vapiCallId))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, say: { ok: false, status: 500 }, addMessage: null });
    expect(outbound).toHaveLength(1);
  });

  it("falls back to GET /call/{id} for the controlUrl and remembers it", async () => {
    vi.stubEnv("VAPI_PRIVATE_KEY", "private-key-test");
    const vapiCallId = await bindCall({ status: "in-progress" });
    const outbound = stubFetch([
      {
        match: (r) => r.url === `https://api.vapi.ai/call/${vapiCallId}`,
        respond: () => json(200, { id: vapiCallId, monitor: { controlUrl: CONTROL_URL } }),
      },
      { match: (r) => r.url === CONTROL_URL, respond: () => json(200, {}) },
    ]);
    const res = await notify(notifyRequest(vapiCallId, "declined_retry"));
    expect(await res.json()).toMatchObject({ ok: true, controlUrlSource: "api" });
    expect(outbound).toHaveLength(3);
    expect((await callRow(vapiCallId)).controlUrl).toBe(CONTROL_URL);
  });

  it("does nothing for calls the lab didn't start or that have ended", async () => {
    const outbound = stubFetch([]);
    const notLab = await bindCall({ lab: false, controlUrl: CONTROL_URL, status: "in-progress" });
    const ended = await bindCall({ controlUrl: CONTROL_URL, status: "ended" });
    expect((await notify(notifyRequest(notLab))).status).toBe(404);
    expect((await notify(notifyRequest(ended))).status).toBe(404);
    expect((await notify(notifyRequest("bad id!"))).status).toBe(400);
    expect(outbound).toHaveLength(0);
  });
});
