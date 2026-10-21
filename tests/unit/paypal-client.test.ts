import { describe, expect, it, vi } from "vitest";

import { PayPalClient, RawJson, isUnknownOutcome, type ApiLogEntry } from "@/server/paypal/client";
import {
  PayPalApiError,
  PayPalNetworkError,
  alreadyDoneOutcome,
  isDeclined,
  isDuplicateInvoiceConflict,
} from "@/server/paypal/errors";
import { authorizeOrder, createAuthorizeOrder, firstAuthorization } from "@/server/paypal/orders";
import { captureAuthorization, reauthorizeAuthorization, voidAuthorization } from "@/server/paypal/payments";

import { fakeFetch, json, tokenRoute, type Recorded } from "../support/fake-fetch";

const API = "https://api-m.sandbox.paypal.com";

function makeClient(
  routes: Parameters<typeof fakeFetch>[0],
  extra: Partial<ConstructorParameters<typeof PayPalClient>[0]> = {},
) {
  const fake = fakeFetch([tokenRoute, ...routes]);
  const logs: ApiLogEntry[] = [];
  const client = new PayPalClient({
    clientId: "cid",
    clientSecret: "secret",
    instanceId: "t-unit",
    fetch: fake.fetch,
    sleep: async () => {},
    log: (entry) => logs.push(entry),
    ...extra,
  });
  return { client, calls: fake.calls, logs };
}

const apiCalls = (calls: Recorded[]) => calls.filter((c) => !c.url.endsWith("/v1/oauth2/token"));

const AUTHORIZED_ORDER = {
  id: "ORDER-1",
  status: "COMPLETED",
  intent: "AUTHORIZE",
  purchase_units: [
    {
      amount: { currency_code: "USD", value: "149.00" },
      payments: {
        authorizations: [{ id: "AUTH-1", status: "CREATED", amount: { currency_code: "USD", value: "149.00" } }],
      },
    },
  ],
};

describe("PayPalClient request IDs", () => {
  it("prefixes request IDs with the instance and validates them", () => {
    const { client } = makeClient([]);
    expect(client.requestId("order-authorize", "ORDER-1")).toBe("t-unit:order-authorize:ORDER-1");
    expect(() => client.requestId("has space")).toThrow();
    expect(() => client.requestId("x".repeat(120))).toThrow();
  });

  it("refuses a POST without a request ID or with a foreign prefix", async () => {
    const { client } = makeClient([{ match: () => true, respond: () => json(201, {}) }]);
    await expect(client.post("/v2/checkout/orders", {}, { op: "x", requestId: "" })).rejects.toThrow(
      /PayPal-Request-Id/,
    );
    await expect(client.post("/v2/checkout/orders", {}, { op: "x", requestId: "p1:other" })).rejects.toThrow(
      /instance prefix/,
    );
  });

  it("sends PayPal-Request-Id and Prefer on every POST (global spy)", async () => {
    const { client, calls } = makeClient([
      {
        match: (r) => r.url.endsWith("/v2/checkout/orders"),
        respond: () => json(201, { id: "ORDER-1", status: "CREATED" }),
      },
      { match: (r) => r.url.endsWith("/authorize"), respond: () => json(201, AUTHORIZED_ORDER) },
      { match: (r) => r.url.endsWith("/capture"), respond: () => json(201, { id: "CAP-1", status: "COMPLETED" }) },
      { match: (r) => r.url.endsWith("/void"), respond: () => new Response(null, { status: 204 }) },
      { match: (r) => r.url.endsWith("/reauthorize"), respond: () => json(201, { id: "AUTH-2", status: "CREATED" }) },
    ]);
    await createAuthorizeOrder(client, {
      requestId: client.requestId("order-create", "b1", "1"),
      amountCents: 14900,
      currency: "USD",
      customId: "b1",
      invoiceId: "t-unit-HL-AAAAA-1",
      description: "Holdline hold – Drain clearing",
      brandName: "Northside Plumbing & Electric",
    });
    await authorizeOrder(client, "ORDER-1", { requestId: client.requestId("order-authorize", "ORDER-1") });
    await captureAuthorization(client, "AUTH-1", {
      requestId: client.requestId("capture", "full", "b1"),
      amountCents: 14900,
      currency: "USD",
      finalCapture: true,
    });
    await voidAuthorization(client, "AUTH-1", { requestId: client.requestId("void", "b1") });
    await reauthorizeAuthorization(client, "AUTH-1", {
      requestId: client.requestId("reauth", "AUTH-1"),
      currency: "USD",
    });

    const posts = apiCalls(calls).filter((c) => c.method === "POST");
    expect(posts).toHaveLength(5);
    for (const post of posts) {
      expect(post.headers["PayPal-Request-Id"]).toMatch(/^t-unit:/);
      expect(post.headers.Prefer).toBe("return=representation");
    }
  });
});

describe("PayPalClient bodies", () => {
  it("creates AUTHORIZE orders from cents with a fixed description and no shipping", async () => {
    const { client, calls } = makeClient([
      {
        match: (r) => r.url.endsWith("/v2/checkout/orders"),
        respond: () => json(201, { id: "ORDER-1", status: "CREATED" }),
      },
    ]);
    await createAuthorizeOrder(client, {
      requestId: client.requestId("order-create", "b1", "1"),
      amountCents: 2500,
      currency: "USD",
      customId: "b1",
      invoiceId: "t-unit-LAB-1",
      description: "Holdline lab hold",
      brandName: "Holdline Lab",
    });
    expect(apiCalls(calls)[0].body).toMatchObject({
      intent: "AUTHORIZE",
      purchase_units: [
        { amount: { currency_code: "USD", value: "25.00" }, custom_id: "b1", invoice_id: "t-unit-LAB-1" },
      ],
      payment_source: { paypal: { experience_context: { shipping_preference: "NO_SHIPPING" } } },
    });
  });

  it("sends explicit amount and final_capture on capture", async () => {
    const { client, calls } = makeClient([
      { match: (r) => r.url.endsWith("/capture"), respond: () => json(201, { id: "CAP-1", status: "COMPLETED" }) },
    ]);
    await captureAuthorization(client, "AUTH-1", {
      requestId: client.requestId("capture", "no_show", "b1"),
      amountCents: 4900,
      currency: "USD",
      finalCapture: true,
      invoiceId: "t-unit-HL-AAAAA",
    });
    expect(apiCalls(calls)[0].body).toEqual({
      final_capture: true,
      amount: { currency_code: "USD", value: "49.00" },
      invoice_id: "t-unit-HL-AAAAA",
    });
  });

  it("reads the authorization out of an authorized order", () => {
    expect(firstAuthorization(AUTHORIZED_ORDER as never)?.id).toBe("AUTH-1");
  });
});

describe("PayPalClient retries and errors", () => {
  it("retries 5xx with the SAME request ID and then succeeds", async () => {
    let n = 0;
    const { client, calls, logs } = makeClient([
      {
        match: (r) => r.url.endsWith("/authorize"),
        respond: () => (++n < 3 ? json(503, { name: "SERVICE_UNAVAILABLE" }) : json(201, AUTHORIZED_ORDER)),
      },
    ]);
    await authorizeOrder(client, "ORDER-1", { requestId: client.requestId("order-authorize", "ORDER-1") });
    const ids = apiCalls(calls).map((c) => c.headers["PayPal-Request-Id"]);
    expect(ids).toEqual(Array(3).fill("t-unit:order-authorize:ORDER-1"));
    expect(logs.at(-1)).toMatchObject({ op: "orders.authorize", httpStatus: 201, attempts: 3 });
    expect(logs.at(-1)?.resourceIds).toEqual({
      orderId: "ORDER-1",
      authorizationId: "AUTH-1",
      authorizationStatus: "CREATED",
    });
  });

  it("retries network errors and 409 PREVIOUS_REQUEST_IN_PROGRESS, then reports an unknown outcome", async () => {
    let n = 0;
    const { client } = makeClient([
      {
        match: (r) => r.url.endsWith("/capture"),
        respond: () =>
          ++n === 1
            ? new TypeError("socket hang up")
            : json(409, { name: "RESOURCE_CONFLICT", details: [{ issue: "PREVIOUS_REQUEST_IN_PROGRESS" }] }),
      },
    ]);
    const error = await captureAuthorization(client, "AUTH-1", {
      requestId: client.requestId("capture", "full", "b1"),
      currency: "USD",
      finalCapture: true,
    }).catch((e: unknown) => e);
    expect(n).toBe(3);
    expect(error).toBeInstanceOf(PayPalApiError);
    expect(isUnknownOutcome(error)).toBe(true);
  });

  it("treats exhausted network failures as an unknown outcome, never as failed", async () => {
    const { client } = makeClient([
      { match: (r) => r.url.endsWith("/void"), respond: () => new TypeError("ECONNRESET") },
    ]);
    const error = await voidAuthorization(client, "AUTH-1", { requestId: client.requestId("void", "b1") }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(PayPalNetworkError);
    expect(isUnknownOutcome(error)).toBe(true);
  });

  it("does not retry 4xx and parses issue + debug_id", async () => {
    let n = 0;
    const { client, logs } = makeClient([
      {
        match: (r) => r.url.endsWith("/authorize"),
        respond: () => {
          n += 1;
          return json(422, {
            name: "UNPROCESSABLE_ENTITY",
            message: "The requested action could not be performed.",
            debug_id: "dbg123",
            details: [{ issue: "INSTRUMENT_DECLINED", description: "declined" }],
          });
        },
      },
    ]);
    const error = (await authorizeOrder(client, "ORDER-1", {
      requestId: client.requestId("order-authorize", "ORDER-1"),
    }).catch((e) => e)) as PayPalApiError;
    expect(n).toBe(1);
    expect(error).toMatchObject({ status: 422, issue: "INSTRUMENT_DECLINED", debugId: "dbg123" });
    expect(isDeclined(error)).toBe(true);
    expect(isUnknownOutcome(error)).toBe(false);
    expect(logs.at(-1)).toMatchObject({ httpStatus: 422, issue: "INSTRUMENT_DECLINED", debugId: "dbg123" });
  });

  it("maps 'already done' issues", () => {
    const err = (issue: string) => new PayPalApiError({ status: 422, issue });
    expect(alreadyDoneOutcome("capture", err("AUTHORIZATION_ALREADY_CAPTURED"))).toBe("captured");
    expect(alreadyDoneOutcome("capture", err("PREVIOUSLY_CAPTURED"))).toBe("captured");
    expect(alreadyDoneOutcome("capture", err("DUPLICATE_INVOICE_ID"))).toBe("captured");
    expect(alreadyDoneOutcome("void", err("PREVIOUSLY_VOIDED"))).toBe("voided");
    // PREVIOUSLY_CAPTURED on void: the money was captured — never count it as voided.
    expect(alreadyDoneOutcome("void", err("PREVIOUSLY_CAPTURED"))).toBe("captured");
    expect(alreadyDoneOutcome("authorize", err("ORDER_ALREADY_AUTHORIZED"))).toBe("authorized");
    expect(alreadyDoneOutcome("authorize", err("DUPLICATE_INVOICE_ID"))).toBeNull();
    expect(alreadyDoneOutcome("capture", err("INSTRUMENT_DECLINED"))).toBeNull();
    expect(isDuplicateInvoiceConflict(err("DUPLICATE_INVOICE_ID"))).toBe(true);
  });
});

describe("PayPalClient OAuth", () => {
  it("caches the token and refreshes it once on 401", async () => {
    let tokenCalls = 0;
    let first = true;
    const fake = fakeFetch([
      {
        match: (r) => r.url.endsWith("/v1/oauth2/token"),
        respond: () => {
          tokenCalls += 1;
          return json(200, { access_token: `tok-${tokenCalls}`, expires_in: 32400 });
        },
      },
      {
        match: (r) => r.url.includes("/v2/checkout/orders/"),
        respond: (req) => {
          if (first && req.headers.Authorization === "Bearer tok-1") {
            first = false;
            return json(401, { name: "AUTHENTICATION_FAILURE" });
          }
          return json(200, { id: "ORDER-1", status: "APPROVED" });
        },
      },
    ]);
    const client = new PayPalClient({ clientId: "cid", clientSecret: "s", instanceId: "t-unit", fetch: fake.fetch });
    await client.get(`/v2/checkout/orders/ORDER-1`, { op: "orders.get" });
    await client.get(`/v2/checkout/orders/ORDER-1`, { op: "orders.get" });
    expect(tokenCalls).toBe(2); // initial + one refresh after the 401, then cached
    const tokenReq = fake.calls.find((c) => c.url.endsWith("/v1/oauth2/token"));
    expect(tokenReq?.headers.Authorization).toBe(`Basic ${Buffer.from("cid:s").toString("base64")}`);
  });

  it("refreshes an expiring token", async () => {
    let now = 0;
    let tokenCalls = 0;
    const fake = fakeFetch([
      {
        match: (r) => r.url.endsWith("/v1/oauth2/token"),
        respond: () => json(200, { access_token: `tok-${++tokenCalls}`, expires_in: 600 }),
      },
      { match: () => true, respond: () => json(200, { id: "x" }) },
    ]);
    const client = new PayPalClient({
      clientId: "c",
      clientSecret: "s",
      instanceId: "t-unit",
      fetch: fake.fetch,
      now: () => now,
    });
    await client.get("/v1/x", { op: "x" });
    now = 400_000; // inside the 5-minute refresh margin of a 10-minute token
    await client.get("/v1/x", { op: "x" });
    expect(tokenCalls).toBe(2);
  });

  it("only sends PayPal-Mock-Response when allowed", async () => {
    const { client } = makeClient([{ match: () => true, respond: () => json(201, AUTHORIZED_ORDER) }]);
    await expect(
      authorizeOrder(client, "ORDER-1", {
        requestId: client.requestId("a"),
        mockResponse: '{"mock_application_codes":"INSTRUMENT_DECLINED"}',
      }),
    ).rejects.toThrow(/only allowed/);

    const allowed = makeClient([{ match: () => true, respond: () => json(201, AUTHORIZED_ORDER) }], {
      allowMockResponses: true,
    });
    await authorizeOrder(allowed.client, "ORDER-1", {
      requestId: allowed.client.requestId("a"),
      mockResponse: '{"mock_application_codes":"INSTRUMENT_DECLINED"}',
    });
    expect(apiCalls(allowed.calls)[0].headers["PayPal-Mock-Response"]).toContain("INSTRUMENT_DECLINED");
  });

  it("only ever calls the sandbox host", async () => {
    const { client, calls } = makeClient([{ match: () => true, respond: () => json(200, {}) }]);
    await client.get("/v2/checkout/orders/X", { op: "orders.get" });
    expect(calls.every((c) => c.url.startsWith(API))).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("PayPalClient edge cases from review", () => {
  it("retries a 2xx whose body can't be read (same request ID) and reports an unknown outcome if it persists", async () => {
    let n = 0;
    const { client, calls, logs } = makeClient([
      {
        match: (r) => r.url.endsWith("/capture"),
        respond: () => {
          n += 1;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new DOMException("aborted", "TimeoutError"));
              },
            }),
            { status: 201 },
          );
        },
      },
    ]);
    const error = await captureAuthorization(client, "AUTH-1", {
      requestId: client.requestId("capture", "full", "b1"),
      currency: "USD",
      finalCapture: true,
    }).catch((e: unknown) => e);
    expect(n).toBe(3);
    expect(new Set(apiCalls(calls).map((c) => c.headers["PayPal-Request-Id"]))).toEqual(
      new Set(["t-unit:capture:full:b1"]),
    );
    expect(error).toBeInstanceOf(PayPalNetworkError);
    expect(isUnknownOutcome(error)).toBe(true);
    expect(logs.at(-1)).toMatchObject({ httpStatus: 201, issue: "BODY_READ_FAILED" });
  });

  it("recovers when a retried 2xx body arrives intact", async () => {
    let n = 0;
    const { client } = makeClient([
      {
        match: (r) => r.url.endsWith("/capture"),
        respond: () =>
          ++n === 1 ? new Response("{not json", { status: 201 }) : json(201, { id: "CAP-1", status: "COMPLETED" }),
      },
    ]);
    const capture = await captureAuthorization(client, "AUTH-1", {
      requestId: client.requestId("capture", "full", "b1"),
      currency: "USD",
      finalCapture: true,
    });
    expect(capture.id).toBe("CAP-1");
  });

  it("retries OAuth 5xx; a final OAuth failure is definite (request never sent) and logged", async () => {
    let tokenCalls = 0;
    const fake = fakeFetch([
      {
        match: (r) => r.url.endsWith("/v1/oauth2/token"),
        respond: () => {
          tokenCalls += 1;
          return json(503, { error: "temporarily_unavailable" });
        },
      },
      { match: () => true, respond: () => json(200, {}) },
    ]);
    const logs: ApiLogEntry[] = [];
    const client = new PayPalClient({
      clientId: "c",
      clientSecret: "s",
      instanceId: "t-unit",
      fetch: fake.fetch,
      sleep: async () => {},
      log: (e) => logs.push(e),
    });
    const error = (await client.get("/v2/checkout/orders/X", { op: "orders.get" }).catch((e) => e)) as PayPalApiError;
    expect(tokenCalls).toBe(3);
    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error.phase).toBe("oauth");
    expect(isUnknownOutcome(error)).toBe(false);
    expect(logs.at(-1)).toMatchObject({ path: "/v1/oauth2/token", httpStatus: 503 });
    expect(fake.calls.some((c) => c.url.includes("/v2/checkout/orders"))).toBe(false);
  });

  it("sends a RawJson body byte-for-byte", async () => {
    const raw = '{"a": "x\\/y" ,  "b":1}';
    let sent: string | undefined;
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
        if (String(input).endsWith("verify-webhook-signature")) sent = init?.body as string;
        return fake.fetch(input, {
          ...init,
          headers: { ...(init?.headers as Record<string, string>), "Content-Type": "text/plain" },
        });
      }) as typeof fetch,
    });
    await client.post("/v1/notifications/verify-webhook-signature", new RawJson(raw), {
      op: "webhooks.verify",
      requestId: client.requestId("verify", "t1"),
    });
    expect(sent).toBe(raw);
  });
});
