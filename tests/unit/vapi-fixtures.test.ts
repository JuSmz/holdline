import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseServerMessage, reportOf, statusOf, toolCallsOf, turnLatencyStats } from "@/server/vapi/messages";
import { projectWebCall, webCallResponseSchema } from "@/server/vapi/web-call";

/** Real payloads from voice-spike call 3 (tests/fixtures/vapi/README.md). */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/vapi", name), "utf8"));
}

describe("real Vapi payloads", () => {
  it("the /call/web response carries a controlUrl, and the projection drops it", () => {
    const raw = fixture("call-web-created.json") as Record<string, unknown>;
    // The stored copy is redacted; a real response has a URL here.
    const call = webCallResponseSchema.parse({ ...raw, webCallUrl: "https://vapi.daily.co/room" });
    expect(call).toMatchObject({ type: "webCall", status: "queued" });
    expect(call.monitor?.controlUrl).toBeTruthy();
    expect(JSON.stringify(projectWebCall(call))).not.toContain("control");
  });

  it("status updates: the message status is current, the embedded call status is stale", () => {
    for (const [name, status] of [
      ["status-update-in-progress.json", "in-progress"],
      ["status-update-ended.json", "ended"],
    ] as const) {
      const message = parseServerMessage(fixture(name));
      expect(message?.call?.type).toBe("webCall");
      expect(message?.call?.monitor?.controlUrl).toBeTruthy();
      expect(message && statusOf(message)?.status).toBe(status);
    }
  });

  it("tool calls arrive with object arguments", () => {
    const message = parseServerMessage(fixture("tool-calls.json"));
    expect(message?.type).toBe("tool-calls");
    expect(message && toolCallsOf(message)).toEqual([
      { id: expect.any(String), name: "get_services", args: { category: "plumbing", urgent: false } },
    ]);
  });

  it("the end-of-call report yields cost, duration, model and turn latencies", () => {
    const message = parseServerMessage(fixture("end-of-call-report.json"));
    const report = message && reportOf(message);
    expect(report).toMatchObject({ endedReason: "assistant-ended-call", costCents: 21, llmModel: "gemini-3.5-flash" });
    expect(report?.durationS).toBeGreaterThan(130);
    expect(report?.transcript).toContain("drain");
    expect(turnLatencyStats(report?.metrics)?.n).toBe(8);
  });
});
