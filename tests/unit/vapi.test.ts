import { describe, expect, it } from "vitest";

import {
  assistantBody,
  LAB_SYSTEM_PROMPT,
  TOOL_DEFINITIONS,
  toolBody,
  type SetupInput,
} from "@/server/vapi/assistant-config";
import { VapiApiError, VapiClient } from "@/server/vapi/client";
import { isAllowedControlUrl, sendControl } from "@/server/vapi/control";
import {
  parseServerMessage,
  redactForFixture,
  reportOf,
  statusOf,
  toolCallsOf,
  turnLatencyStats,
} from "@/server/vapi/messages";
import { projectWebCall, webCallResponseSchema } from "@/server/vapi/web-call";

import { fakeFetch, json } from "../support/fake-fetch";

const CONTROL_URL = "https://phone-call-websocket.aws-us-west-2-backend-production1.vapi.ai/call-1/control";

describe("isAllowedControlUrl", () => {
  it("accepts https URLs on vapi.ai hosts", () => {
    expect(isAllowedControlUrl(CONTROL_URL)).toBe(true);
    expect(isAllowedControlUrl("https://vapi.ai/x")).toBe(true);
  });

  it.each([
    ["http://phone-call-websocket.vapi.ai/x/control"],
    ["https://evilvapi.ai/x"],
    ["https://vapi.ai.example.com/x"],
    ["https://user:pw@api.vapi.ai/x"],
    ["https://api.vapi.ai:8443/x"],
    ["not a url"],
    [""],
  ])("rejects %s", (value) => {
    expect(isAllowedControlUrl(value)).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isAllowedControlUrl(null)).toBe(false);
    expect(isAllowedControlUrl(undefined)).toBe(false);
  });
});

describe("sendControl", () => {
  it("POSTs the message as JSON", async () => {
    const { fetch, calls } = fakeFetch([{ match: () => true, respond: () => json(200, { ok: true }) }]);
    const result = await sendControl(CONTROL_URL, { type: "say", content: "Hello" }, { fetch });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(calls).toEqual([
      expect.objectContaining({ method: "POST", url: CONTROL_URL, body: { type: "say", content: "Hello" } }),
    ]);
  });

  it("never sends to a URL outside vapi.ai", async () => {
    const { fetch, calls } = fakeFetch([]);
    const result = await sendControl("https://example.com/control", { type: "end-call" }, { fetch });
    expect(result).toEqual({ ok: false, status: null, ms: 0, error: "control_url_not_allowed" });
    expect(calls).toHaveLength(0);
  });

  it("reports a non-2xx answer and network failures without throwing", async () => {
    const gone = fakeFetch([{ match: () => true, respond: () => json(404, { message: "call not found" }) }]);
    expect(await sendControl(CONTROL_URL, { type: "end-call" }, { fetch: gone.fetch })).toMatchObject({
      ok: false,
      status: 404,
    });
    const down = fakeFetch([{ match: () => true, respond: () => new TypeError("fetch failed") }]);
    expect(await sendControl(CONTROL_URL, { type: "end-call" }, { fetch: down.fetch })).toMatchObject({
      ok: false,
      status: null,
      error: "network",
    });
    const slow = fakeFetch([
      { match: () => true, respond: () => new DOMException("The operation timed out.", "TimeoutError") },
    ]);
    expect(await sendControl(CONTROL_URL, { type: "end-call" }, { fetch: slow.fetch })).toMatchObject({
      error: "timeout",
    });
  });
});

describe("server messages", () => {
  it("parses the envelope and rejects anything else", () => {
    const message = parseServerMessage({
      message: { type: "status-update", status: "in-progress", call: { id: "c1", type: "webCall" } },
    });
    expect(message?.type).toBe("status-update");
    expect(message && statusOf(message)).toEqual({ status: "in-progress", endedReason: undefined });
    expect(parseServerMessage({ type: "status-update" })).toBeNull();
    expect(parseServerMessage({ message: { type: "" } })).toBeNull();
    expect(parseServerMessage(null)).toBeNull();
  });

  it("reads tool calls with string or object arguments", () => {
    const message = parseServerMessage({
      message: {
        type: "tool-calls",
        toolCallList: [
          { id: "t1", type: "function", function: { name: "get_services", arguments: '{"category":"plumbing"}' } },
          { id: "t2", type: "function", function: { name: "get_services", arguments: { urgent: true } } },
          { id: "t3", type: "function", function: { name: "get_services", arguments: "not json" } },
          { id: "t4", type: "function", function: { name: "get_services", arguments: "[1,2]" } },
          { id: "t5", type: "function", function: { name: "get_services" } },
          { id: "t6", type: "function", function: { name: "get_services", arguments: null } },
          { id: "t7", type: "function", function: { name: "get_services", arguments: "x".repeat(20_001) } },
          { id: "t8", type: "function", function: { name: "" } },
          { id: "t9" },
          { nope: true },
          { id: "" },
        ],
      },
    });
    expect(message && toolCallsOf(message)).toEqual([
      { id: "t1", name: "get_services", args: { category: "plumbing" } },
      { id: "t2", name: "get_services", args: { urgent: true } },
      { id: "t3", name: "get_services", args: null },
      { id: "t4", name: "get_services", args: null },
      { id: "t5", name: "get_services", args: {} },
      // Malformed entries with a usable id still get an (error) result.
      { id: "t6", name: "get_services", args: null },
      { id: "t7", name: "get_services", args: null },
      { id: "t8", name: "unknown", args: null },
      { id: "t9", name: "unknown", args: null },
    ]);
    expect(toolCallsOf({ type: "tool-calls" })).toEqual([]);
  });

  it("reads the end-of-call report", () => {
    const message = parseServerMessage({
      message: {
        type: "end-of-call-report",
        endedReason: "customer-ended-call",
        cost: 0.1234,
        startedAt: "2026-10-21T18:00:00.000Z",
        endedAt: "2026-10-21T18:03:05.400Z",
        artifact: {
          transcript: "AI: Hi\nUser: Hello",
          messages: [{ role: "bot", message: "Hi" }],
          performanceMetrics: { turnLatencies: [{ turnLatency: 900 }, { turnLatency: 1500 }, { turnLatency: 1100 }] },
        },
        assistant: { model: { provider: "google", model: "gemini-3.5-flash" } },
      },
    });
    const report = message && reportOf(message);
    expect(report).toMatchObject({
      endedReason: "customer-ended-call",
      costCents: 12,
      durationS: 185,
      transcript: "AI: Hi\nUser: Hello",
      llmModel: "gemini-3.5-flash",
    });
    expect(turnLatencyStats(report?.metrics)).toEqual({ n: 3, p50: 1100, p95: 1500 });
    expect(turnLatencyStats({ turnLatencies: [] })).toBeNull();
    // A turn without a number (all TurnLatency fields are optional) is skipped, not fatal.
    expect(
      turnLatencyStats({ turnLatencies: [{ turnLatency: 800 }, { modelLatency: 300 }, { turnLatency: null }, null] }),
    ).toEqual({ n: 1, p50: 800, p95: 800 });
    expect(turnLatencyStats(null)).toBeNull();
  });
});

describe("redactForFixture", () => {
  it("replaces capability URLs and tokens, keeps everything else", () => {
    const redacted = redactForFixture({
      message: {
        type: "status-update",
        call: {
          id: "c1",
          monitor: { controlUrl: CONTROL_URL, listenUrl: "wss://x.vapi.ai/listen" },
          webCallUrl: "https://vapi.daily.co/room",
          transport: { callToken: "secret-token" },
        },
        artifact: { messages: [{ recordingUrl: "https://storage/x.wav", message: "Hi" }] },
      },
    });
    expect(redacted).toEqual({
      message: {
        type: "status-update",
        call: {
          id: "c1",
          monitor: { controlUrl: "[redacted]", listenUrl: "[redacted]" },
          webCallUrl: "[redacted]",
          transport: { callToken: "[redacted]" },
        },
        artifact: { messages: [{ recordingUrl: "[redacted]", message: "Hi" }] },
      },
    });
  });
});

describe("projectWebCall", () => {
  it("returns only what the web SDK reads: no controlUrl, prompt or tools", () => {
    const call = webCallResponseSchema.parse({
      id: "call-1",
      type: "webCall",
      status: "queued",
      webCallUrl: "https://vapi.daily.co/room",
      monitor: { controlUrl: CONTROL_URL, listenUrl: "wss://x" },
      transport: { provider: "daily", callUrl: "https://vapi.daily.co/room" },
      assistant: {
        voice: { provider: "vapi", voiceId: "Elliot" },
        model: { model: "gemini-3.5-flash", messages: [{ role: "system", content: LAB_SYSTEM_PROMPT }] },
        server: { url: "https://holdline.test/api/vapi/events" },
      },
    });
    const projected = projectWebCall(call);
    expect(projected).toEqual({
      id: "call-1",
      webCallUrl: "https://vapi.daily.co/room",
      transport: { provider: "daily" },
      artifactPlan: { videoRecordingEnabled: false },
      assistant: { voice: { provider: "vapi" } },
    });
    expect(JSON.stringify(projected)).not.toContain("control");
  });

  it("requires an id and a webCallUrl", () => {
    expect(webCallResponseSchema.safeParse({ id: "call-1" }).success).toBe(false);
  });
});

describe("saved assistant configuration", () => {
  const input: SetupInput = {
    appUrl: "https://holdline.test",
    credentialId: "cred-1",
    provider: "google",
    model: "gemini-3.5-flash",
    maxTokens: 1000,
    temperature: 1,
    maxCallSeconds: 480,
    instanceId: "t",
  };

  it("routes webhooks to our server with the credential and keeps recordings off", () => {
    const body = assistantBody(input, ["tool-1"]);
    expect(body.server).toEqual({
      url: "https://holdline.test/api/vapi/events",
      credentialId: "cred-1",
      timeoutSeconds: 10,
    });
    expect(body.serverMessages).toEqual(["tool-calls", "status-update", "end-of-call-report"]);
    expect(body.monitorPlan).toEqual({ controlEnabled: true, listenEnabled: false });
    expect(body.artifactPlan.recordingEnabled).toBe(false);
    expect(body.model).toMatchObject({ provider: "google", model: "gemini-3.5-flash", toolIds: ["tool-1"] });
    expect(body.maxDurationSeconds).toBe(480);
    expect(body.hooks[0]).toMatchObject({ on: "customer.speech.timeout", options: { timeoutSeconds: 30 } });
    // Sent separately by the setup script, so a rejection can't block the rest.
    expect(body).not.toHaveProperty("silenceTimeoutSeconds");
  });

  it("points every tool at /api/vapi/tools with the credential", () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(toolBody(def, input).server).toEqual({
        url: "https://holdline.test/api/vapi/tools",
        credentialId: "cred-1",
        timeoutSeconds: 10,
      });
    }
  });

  it("forbids confirmation words before a payment update", () => {
    expect(LAB_SYSTEM_PROMPT).toContain("Never say confirmed, booked, all set, locked in or reserved");
    expect(LAB_SYSTEM_PROMPT).toContain("[payment-update]");
  });
});

describe("VapiClient", () => {
  it("sends the private key as Bearer and JSON bodies, and refuses redirects", async () => {
    const { fetch, calls } = fakeFetch([{ match: () => true, respond: () => json(201, { id: "a1" }) }]);
    let init: RequestInit | undefined;
    const spy: typeof globalThis.fetch = (input, i) => {
      init = i;
      return fetch(input, i);
    };
    const client = new VapiClient({ apiKey: "private-key", fetch: spy });
    expect(await client.post("/assistant", { name: "Holdline" })).toEqual({ id: "a1" });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.vapi.ai/assistant",
      headers: { Authorization: "Bearer private-key" },
      body: { name: "Holdline" },
    });
    expect(init?.redirect).toBe("error");
  });

  it("turns error answers into VapiApiError with Vapi's message", async () => {
    const { fetch } = fakeFetch([
      {
        match: () => true,
        respond: () => json(400, { message: ["property x should not exist"], error: "Bad Request" }),
      },
    ]);
    const error = await new VapiClient({ apiKey: "k", fetch }).get("/assistant").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VapiApiError);
    expect(error).toMatchObject({ status: 400, detail: "property x should not exist" });
    expect(String(error)).not.toContain("Bearer");
  });
});
