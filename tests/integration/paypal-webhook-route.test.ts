import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { POST as webhook } from "@/app/api/paypal/webhook/route";
import { closeDb, getDb } from "@/db/client";
import { webhookEvents } from "@/db/schema";
import { clearCertCache, webhookDeps } from "@/server/paypal/webhooks";

import { headersToRequestInit, makeTestCert, signWebhook } from "../support/test-cert";

const WEBHOOK_ID = "1JE4291016473214C";
let pki: { certPem: string; keyPem: string };

beforeAll(() => {
  pki = makeTestCert();
  webhookDeps.fetchCert = async () => pki.certPem;
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearCertCache();
});

afterAll(async () => {
  await closeDb();
});

function eventBody(id: string) {
  return JSON.stringify({
    id,
    event_type: "PAYMENT.AUTHORIZATION.CREATED",
    resource_type: "authorization",
    summary: "A payment authorization was created",
    resource: { id: "AUTH-TEST-1", status: "CREATED" },
  });
}

function post(body: string, headers: Record<string, string>) {
  return webhook(new Request("http://localhost/api/paypal/webhook", { method: "POST", body, headers }));
}

async function rowsFor(eventId: string) {
  return getDb().select().from(webhookEvents).where(eq(webhookEvents.paypalEventId, eventId));
}

describe("POST /api/paypal/webhook", () => {
  it("returns 503 until PAYPAL_WEBHOOK_ID is configured", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    expect((await post("{}", {})).status).toBe(503);
  });

  it("stores a verified event once, and reports the duplicate delivery", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", WEBHOOK_ID);
    const eventId = `WH-${crypto.randomUUID()}`;
    const body = eventBody(eventId);
    const headers = headersToRequestInit(signWebhook(pki.keyPem, new TextEncoder().encode(body), WEBHOOK_ID));

    const first = await post(body, headers);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false });

    const second = await post(body, headers);
    expect(await second.json()).toEqual({ ok: true, duplicate: true });

    const rows = await rowsFor(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "PAYMENT.AUTHORIZATION.CREATED",
      resourceId: "AUTH-TEST-1",
      verifiedVia: "offline",
      simulated: false,
      processedAt: null,
    });
  });

  it("concurrent duplicate deliveries still store exactly one row", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", WEBHOOK_ID);
    const eventId = `WH-${crypto.randomUUID()}`;
    const body = eventBody(eventId);
    const headers = headersToRequestInit(signWebhook(pki.keyPem, new TextEncoder().encode(body), WEBHOOK_ID));
    const results = await Promise.all([post(body, headers), post(body, headers), post(body, headers)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await rowsFor(eventId)).toHaveLength(1);
  });

  it("rejects a forged or tampered event with 400 and stores nothing", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", WEBHOOK_ID);
    const eventId = `WH-${crypto.randomUUID()}`;
    const signedFor = eventBody(eventId);
    const headers = headersToRequestInit(signWebhook(pki.keyPem, new TextEncoder().encode(signedFor), WEBHOOK_ID));
    const tampered = signedFor.replace("AUTH-TEST-1", "AUTH-EVIL-9");

    const res = await post(tampered, headers);
    expect(res.status).toBe(400);
    expect(await rowsFor(eventId)).toHaveLength(0);
  });

  it("rejects requests without signature headers and oversized bodies", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", WEBHOOK_ID);
    expect((await post(eventBody("WH-x"), { "content-type": "application/json" })).status).toBe(400);
    expect((await post("x".repeat(70 * 1024), {})).status).toBe(413);
  });
});
