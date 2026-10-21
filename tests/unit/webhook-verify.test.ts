import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CertFetchError,
  clearCertCache,
  isAllowedCertUrl,
  readBodyLimited,
  signedMessage,
  verifyWebhookOffline,
  verifyWebhookViaApi,
  webhookDeps,
} from "@/server/paypal/webhooks";

import { PayPalClient } from "@/server/paypal/client";

import { fakeFetch, json, tokenRoute } from "../support/fake-fetch";
import { CERT_URL, makeTestCert, signWebhook } from "../support/test-cert";

const WEBHOOK_ID = "1JE4291016473214C";
const body = new TextEncoder().encode(JSON.stringify({ id: "WH-1", event_type: "PAYMENT.AUTHORIZATION.CREATED" }));
let pki: { certPem: string; keyPem: string };

beforeAll(() => {
  pki = makeTestCert();
});

afterEach(() => {
  clearCertCache();
  webhookDeps.fetchCert = async () => pki.certPem;
  webhookDeps.now = () => new Date();
});

describe("isAllowedCertUrl", () => {
  it("accepts PayPal's sandbox cert URL", () => {
    expect(isAllowedCertUrl(CERT_URL)).toBe(true);
  });

  it.each([
    "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com.evil.tld/v1/notifications/certs/CERT-1",
    "https://api.paypal.com@evil.tld/v1/notifications/certs/CERT-1",
    "https://user:pw@api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-1",
    "https://api.sandbox.paypal.com/v1/other/CERT-1",
    "https://api.paypal.com/v1/notifications/certs/CERT-1", // live host: sandbox-only app
    "not a url",
  ])("rejects %s", (url) => {
    expect(isAllowedCertUrl(url)).toBe(false);
  });
});

describe("signedMessage", () => {
  it("uses the unsigned decimal CRC32 of the raw bytes", () => {
    const msg = signedMessage(
      { transmissionId: "t", transmissionTime: "time", certUrl: "", authAlgo: "", transmissionSig: "" },
      "wh",
      new Uint8Array([0xff, 0xfe, 0xfd]),
    );
    const crc = Number(msg.split("|")[3]);
    expect(Number.isInteger(crc) && crc >= 0).toBe(true);
  });
});

describe("verifyWebhookOffline", () => {
  it("accepts a correctly signed event", async () => {
    webhookDeps.fetchCert = async () => pki.certPem;
    const headers = signWebhook(pki.keyPem, body, WEBHOOK_ID);
    await expect(
      verifyWebhookOffline({ headers, body, webhookId: WEBHOOK_ID, acceptSimulator: false }),
    ).resolves.toEqual({
      ok: true,
      via: "offline",
      simulated: false,
    });
  });

  it("rejects a tampered body", async () => {
    webhookDeps.fetchCert = async () => pki.certPem;
    const headers = signWebhook(pki.keyPem, body, WEBHOOK_ID);
    const tampered = new TextEncoder().encode(JSON.stringify({ id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED" }));
    const result = await verifyWebhookOffline({
      headers,
      body: tampered,
      webhookId: WEBHOOK_ID,
      acceptSimulator: false,
    });
    expect(result).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a signature made for another webhook ID", async () => {
    webhookDeps.fetchCert = async () => pki.certPem;
    const headers = signWebhook(pki.keyPem, body, "OTHER-WEBHOOK");
    const result = await verifyWebhookOffline({ headers, body, webhookId: WEBHOOK_ID, acceptSimulator: false });
    expect(result.ok).toBe(false);
  });

  it("accepts simulator events only when explicitly allowed (lab)", async () => {
    webhookDeps.fetchCert = async () => pki.certPem;
    const headers = signWebhook(pki.keyPem, body, "WEBHOOK_ID");
    expect((await verifyWebhookOffline({ headers, body, webhookId: WEBHOOK_ID, acceptSimulator: false })).ok).toBe(
      false,
    );
    clearCertCache();
    await expect(
      verifyWebhookOffline({ headers, body, webhookId: WEBHOOK_ID, acceptSimulator: true }),
    ).resolves.toEqual({
      ok: true,
      via: "offline",
      simulated: true,
    });
  });

  it("never fetches a cert from a disallowed host and never falls back to the API", async () => {
    let fetched = false;
    webhookDeps.fetchCert = async () => {
      fetched = true;
      return pki.certPem;
    };
    const headers = signWebhook(pki.keyPem, body, WEBHOOK_ID, {
      certUrl: "https://api.sandbox.paypal.com.evil.tld/v1/notifications/certs/X",
    });
    const result = await verifyWebhookOffline({ headers, body, webhookId: WEBHOOK_ID, acceptSimulator: false });
    expect(result).toMatchObject({
      ok: false,
      reason: "cert_url_not_allowed",
      detail: "api.sandbox.paypal.com.evil.tld",
    });
    expect(result).not.toHaveProperty("retryViaApi", true);
    expect(fetched).toBe(false);
  });

  it("rejects an expired certificate", async () => {
    webhookDeps.fetchCert = async () => pki.certPem;
    webhookDeps.now = () => new Date(Date.now() + 30 * 86_400_000);
    const headers = signWebhook(pki.keyPem, body, WEBHOOK_ID);
    const result = await verifyWebhookOffline({ headers, body, webhookId: WEBHOOK_ID, acceptSimulator: false });
    expect(result).toMatchObject({ ok: false, reason: "cert_expired" });
  });

  it("falls back to API verification only when an allowed cert fetch fails transiently", async () => {
    webhookDeps.fetchCert = async () => {
      throw new CertFetchError("timeout", true);
    };
    const headers = signWebhook(pki.keyPem, body, WEBHOOK_ID);
    const result = await verifyWebhookOffline({ headers, body, webhookId: WEBHOOK_ID, acceptSimulator: false });
    expect(result).toMatchObject({ ok: false, reason: "cert_fetch_failed", retryViaApi: true });
  });
});

describe("readBodyLimited", () => {
  it("rejects bodies over the limit, by header or by stream", async () => {
    const big = "x".repeat(100);
    expect(await readBodyLimited(new Request("http://x", { method: "POST", body: big }), 50)).toBeNull();
    const streamed = new Request("http://x", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(await readBodyLimited(streamed, 50)).toBeNull();
    expect((await readBodyLimited(new Request("http://x", { method: "POST", body: "ok" }), 50))?.byteLength).toBe(2);
  });
});

describe("hardening from review", () => {
  it.each([
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1?x=1",
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1#frag",
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1/../../other",
    "https://api.sandbox.paypal.com/v1/notifications/certs/NOTCERT-1",
  ])("rejects odd cert URL %s", (url) => {
    expect(isAllowedCertUrl(url)).toBe(false);
  });

  it("treats a permanent cert failure (4xx / bad PEM) as a hard reject without API fallback", async () => {
    webhookDeps.fetchCert = async () => {
      throw new CertFetchError("HTTP 404", false);
    };
    const headers = signWebhook(pki.keyPem, body, WEBHOOK_ID);
    const result = await verifyWebhookOffline({ headers, body, webhookId: WEBHOOK_ID, acceptSimulator: false });
    expect(result).toMatchObject({ ok: false, reason: "cert_fetch_failed", retryViaApi: false });

    clearCertCache();
    webhookDeps.fetchCert = async () => "not a pem";
    const parsed = await verifyWebhookOffline({ headers, body, webhookId: WEBHOOK_ID, acceptSimulator: false });
    expect(parsed).toMatchObject({ ok: false, retryViaApi: false });
  });

  it("negative-caches a failing cert URL", async () => {
    let fetches = 0;
    webhookDeps.fetchCert = async () => {
      fetches += 1;
      throw new CertFetchError("HTTP 404", false);
    };
    const headers = signWebhook(pki.keyPem, body, WEBHOOK_ID);
    await verifyWebhookOffline({ headers, body, webhookId: WEBHOOK_ID, acceptSimulator: false });
    await verifyWebhookOffline({ headers, body, webhookId: WEBHOOK_ID, acceptSimulator: false });
    expect(fetches).toBe(1);
  });

  it("the API fallback sends the event bytes verbatim", async () => {
    const raw = '{ "id":"WH-9",  "event_type":"PAYMENT.CAPTURE.COMPLETED", "x":"a\\/b" }';
    const rawBytes = new TextEncoder().encode(raw);
    let sentBody = "";
    const fake = fakeFetch([
      tokenRoute,
      {
        match: (r) => r.url.endsWith("/v1/notifications/verify-webhook-signature"),
        respond: () => json(200, { verification_status: "SUCCESS" }),
      },
    ]);
    const client = new PayPalClient({
      clientId: "c",
      clientSecret: "s",
      instanceId: "t-unit",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("verify-webhook-signature")) sentBody = String(init?.body);
        return fake.fetch(input, {
          ...init,
          headers: { ...(init?.headers as Record<string, string>), "Content-Type": "text/plain" },
        });
      }) as typeof fetch,
    });
    const headers = signWebhook(pki.keyPem, rawBytes, WEBHOOK_ID);
    const result = await verifyWebhookViaApi(client, { headers, webhookId: WEBHOOK_ID, rawBody: rawBytes });
    expect(result).toEqual({ ok: true, via: "api", simulated: false });
    expect(sentBody.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(sentBody).webhook_id).toBe(WEBHOOK_ID);
  });
});

describe("eventResourceId", () => {
  it("finds the resource ID for every event family", async () => {
    const { eventResourceId } = await import("@/server/paypal/webhook-events");
    expect(eventResourceId({ resource: { id: "AUTH-1" } })).toBe("AUTH-1");
    expect(eventResourceId({ resource: { invoice: { id: "INV2-AAAA-BBBB-CCCC-DDDD" } } })).toBe(
      "INV2-AAAA-BBBB-CCCC-DDDD",
    );
    expect(eventResourceId({ resource: { payout_item_id: "WGGV2KUQXV7M4" } })).toBe("WGGV2KUQXV7M4");
    expect(eventResourceId({ resource: { batch_header: { payout_batch_id: "22NZAZ69HVVSS" } } })).toBe("22NZAZ69HVVSS");
    expect(eventResourceId({})).toBeNull();
  });
});
