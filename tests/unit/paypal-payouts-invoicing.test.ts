import { describe, expect, it } from "vitest";

import { PayPalClient, isUnknownOutcome } from "@/server/paypal/client";
import { PayPalApiError, PayPalNetworkError, parsePayPalError } from "@/server/paypal/errors";
import {
  cancelInvoice,
  createInvoice,
  findInvoiceByNumber,
  invoiceBody,
  invoiceTotalCents,
  isFullyPaid,
  makeInvoiceNumber,
  sendInvoice,
  type Invoice,
} from "@/server/paypal/invoicing";
import {
  createPayout,
  duplicateBatchId,
  payoutErrorOutcome,
  payoutIds,
  payoutItemOutcome,
} from "@/server/paypal/payouts";

import { fakeFetch, json, tokenRoute, type Recorded } from "../support/fake-fetch";

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch([tokenRoute, ...routes]);
  return {
    client: new PayPalClient({
      clientId: "c",
      clientSecret: "s",
      instanceId: "t-unit",
      fetch: fake.fetch,
      sleep: async () => {},
    }),
    calls: fake.calls,
  };
}
const api = (calls: Recorded[]) => calls.filter((c) => !c.url.endsWith("/v1/oauth2/token"));

const PAYOUT = {
  senderBatchId: "t-unit-capture-CAP1-maya-1",
  senderItemId: "t-unit-capture-CAP1-maya-1",
  receiverEmail: "maya@personal.example.com",
  amountCents: 1500,
  currency: "USD" as const,
  emailSubject: "Your Holdline payout",
  emailMessage: "Thanks for the job.",
};

describe("payouts", () => {
  it("builds a single-item EMAIL payout with {value, currency} and a request ID from the batch ID", async () => {
    const { client: c, calls } = client([
      {
        match: (r) => r.url.endsWith("/v1/payments/payouts"),
        respond: () =>
          json(201, { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING", sender_batch_header: {} } }),
      },
    ]);
    await expect(createPayout(c, PAYOUT)).resolves.toEqual({ payoutBatchId: "BATCH1", batchStatus: "PENDING" });
    const [req] = api(calls);
    expect(req.headers["PayPal-Request-Id"]).toBe("t-unit:payout:t-unit-capture-CAP1-maya-1");
    expect(req.body).toMatchObject({
      sender_batch_header: { sender_batch_id: PAYOUT.senderBatchId, recipient_type: "EMAIL" },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: PAYOUT.receiverEmail,
          sender_item_id: PAYOUT.senderItemId,
          amount: { value: "15.00", currency: "USD" },
        },
      ],
    });
  });

  it("requires the instance prefix and a valid sender_batch_id", async () => {
    const { client: c } = client([]);
    await expect(createPayout(c, { ...PAYOUT, senderBatchId: "p1-other" })).rejects.toThrow(/instance prefix/);
    await expect(createPayout(c, { ...PAYOUT, senderBatchId: "t-unit has spaces" })).rejects.toThrow(/invalid/);
  });

  it("allows sandbox negative-test codes in the note only in the lab", async () => {
    const { client: c, calls } = client([
      {
        match: () => true,
        respond: () =>
          json(201, { batch_header: { payout_batch_id: "B", batch_status: "PENDING", sender_batch_header: {} } }),
      },
    ]);
    await expect(createPayout(c, { ...PAYOUT, note: "ERRPYO005" })).rejects.toThrow(/only allowed in the lab/);
    await createPayout(c, { ...PAYOUT, note: "ERRPYO005" }, { allowTestCodes: true });
    expect(api(calls)[0].body).toMatchObject({ items: [{ note: "ERRPYO005" }] });
  });

  it("ignores a link-bearing error that is not about sender_batch_id", () => {
    expect(
      duplicateBatchId(
        new PayPalApiError({
          status: 400,
          links: [{ href: "https://api.sandbox.paypal.com/v1/payments/payouts/ABC123" }],
        }),
      ),
    ).toBeNull();
  });

  it("recovers the original batch ID from a duplicate sender_batch_id rejection (real sandbox shape)", async () => {
    const error = await parsePayPalError(
      json(400, {
        name: "USER_BUSINESS_ERROR",
        message: "User business error.",
        debug_id: "dbg",
        details: [
          {
            field: "SENDER_BATCH_ID",
            issue: "Batch with given sender_batch_id already exists",
            link: [
              { href: "https://api.sandbox.paypal.com/v1/payments/payouts/5UXD2E8A7EBQJ", rel: "self", method: "GET" },
            ],
          },
        ],
      }),
    );
    expect(duplicateBatchId(error)).toBe("5UXD2E8A7EBQJ");
    expect(duplicateBatchId(new PayPalApiError({ status: 400 }))).toBeNull();
    expect(duplicateBatchId(new Error("x"))).toBeNull();
  });

  it("maps item statuses to retry decisions", () => {
    expect(payoutItemOutcome("SUCCESS")).toBe("succeeded");
    expect(payoutItemOutcome("FAILED")).toBe("retryable");
    expect(payoutItemOutcome("RETURNED")).toBe("retryable");
    expect(payoutItemOutcome("BLOCKED")).toBe("retryable");
    expect(payoutItemOutcome("UNCLAIMED")).toBe("cancel_first");
    expect(payoutItemOutcome("PENDING")).toBe("wait");
    expect(payoutItemOutcome("ONHOLD")).toBe("wait");
  });
});

const INVOICE_INPUT = {
  invoiceNumber: "t-unit-HL7K3Q9-X1",
  currency: "USD" as const,
  invoicerEmail: "biz@business.example.com",
  invoicerBusinessName: "Northside Plumbing & Electric",
  recipientEmail: "buyer@personal.example.com",
  items: [
    { name: "Replace valve", quantity: 1, unitAmountCents: 2500 },
    { name: "Extra labor (30 min)", quantity: 2, unitAmountCents: 750 },
  ],
};

describe("invoicing", () => {
  it("makes instance-prefixed invoice numbers of at most 25 characters", () => {
    expect(makeInvoiceNumber("p1", "HL-7K3Q9", 1)).toBe("p1-HL7K3Q9-X1");
    expect(() => makeInvoiceNumber("p1", "X".repeat(30), 1)).toThrow(/too long/);
  });

  it("sends the required fields, no tips and no partial payment", () => {
    const body = invoiceBody(INVOICE_INPUT);
    expect(body.detail).toMatchObject({ currency_code: "USD", invoice_number: "t-unit-HL7K3Q9-X1" });
    expect(body.items[1]).toEqual({
      name: "Extra labor (30 min)",
      quantity: "2",
      unit_amount: { currency_code: "USD", value: "7.50" },
      unit_of_measure: "QUANTITY",
    });
    expect(body.configuration).toEqual({ allow_tip: false, partial_payment: { allow_partial_payment: false } });
    expect(body.invoicer.email_address).toBe("biz@business.example.com");
  });

  it.each([0, -1, 1.5, 21])("rejects quantity %s", (quantity) => {
    expect(() => invoiceBody({ ...INVOICE_INPUT, items: [{ name: "x", quantity, unitAmountCents: 100 }] })).toThrow();
  });

  it("reads the invoice ID from a minimal (link-only) create response", async () => {
    const { client: c } = client([
      {
        match: (r) => r.url.endsWith("/v2/invoicing/invoices"),
        respond: () =>
          json(201, {
            rel: "self",
            href: "https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-AAAA-BBBB-CCCC-DDDD",
            method: "GET",
          }),
      },
    ]);
    await expect(createInvoice(c, INVOICE_INPUT)).resolves.toEqual({
      id: "INV2-AAAA-BBBB-CCCC-DDDD",
      status: null,
      recovered: false,
    });
  });

  it("returns the payer-view URL on send", async () => {
    const { client: c, calls } = client([
      {
        match: (r) => r.url.endsWith("/send"),
        respond: () =>
          json(200, { href: "https://www.sandbox.paypal.com/invoice/p/#INV2-X", rel: "payer-view", method: "GET" }),
      },
    ]);
    await expect(sendInvoice(c, "INV2-X")).resolves.toEqual({
      payerViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-X",
    });
    expect(api(calls)[0].body).toEqual({ send_to_recipient: true, send_to_invoicer: false });
  });

  it("recovers an invoice by OUR number after an unknown create outcome", async () => {
    const { client: c, calls } = client([
      {
        match: (r) => r.url.includes("/v2/invoicing/search-invoices"),
        respond: () =>
          json(200, {
            items: [
              {
                id: "INV2-OTHER",
                status: "SENT",
                detail: { invoice_number: "t-unit-HL7K3Q9-X10", currency_code: "USD" },
              },
              {
                id: "INV2-MINE",
                status: "DRAFT",
                detail: { invoice_number: "t-unit-HL7K3Q9-X1", currency_code: "USD" },
              },
            ],
          }),
      },
    ]);
    const found = await findInvoiceByNumber(c, "t-unit-HL7K3Q9-X1");
    expect(found).toEqual({ id: "INV2-MINE", status: "DRAFT", invoiceNumber: "t-unit-HL7K3Q9-X1" });
    expect(api(calls)[0].body).toEqual({ invoice_number: "t-unit-HL7K3Q9-X1" });
  });

  it("counts an invoice as paid only when PAID and fully paid", () => {
    const base: Invoice = {
      id: "INV2-1",
      status: "PAID",
      detail: { currency_code: "USD" },
      amount: { currency_code: "USD", value: "40.00" },
      payments: { paid_amount: { currency_code: "USD", value: "40.00" } },
    };
    expect(isFullyPaid(base)).toBe(true);
    expect(isFullyPaid({ ...base, payments: { paid_amount: { currency_code: "USD", value: "20.00" } } })).toBe(false);
    for (const status of ["PARTIALLY_PAID", "PAYMENT_PENDING", "MARKED_AS_PAID", "SENT"] as const) {
      expect(isFullyPaid({ ...base, status })).toBe(false);
    }
  });
});

describe("stage-3 review fixes", () => {
  it("derives deterministic, instance-prefixed payout IDs within PayPal's limits", () => {
    const uuid = "019a3f2e-7c1d-7b2a-9f00-1234567890ab";
    const a = payoutIds({
      instanceId: "p1",
      source: "capture",
      sourceId: "5U0311156D662474K",
      technicianKey: uuid,
      attempt: 1,
    });
    const b = payoutIds({
      instanceId: "p1",
      source: "capture",
      sourceId: "5U0311156D662474K",
      technicianKey: uuid,
      attempt: 1,
    });
    const c2 = payoutIds({
      instanceId: "p1",
      source: "capture",
      sourceId: "5U0311156D662474K",
      technicianKey: uuid,
      attempt: 2,
    });
    expect(a).toEqual(b);
    expect(a.senderBatchId).not.toBe(c2.senderBatchId);
    for (const ids of [
      a,
      c2,
      payoutIds({
        instanceId: "t-longer",
        source: "invoice",
        sourceId: "INV2-AAAA-BBBB-CCCC-DDDD".repeat(4),
        technicianKey: uuid,
        attempt: 12,
      }),
    ]) {
      expect(ids.senderBatchId.length).toBeLessThanOrEqual(127);
      expect(ids.senderItemId.length).toBeLessThanOrEqual(63);
      expect(ids.senderBatchId).toMatch(/^[a-z0-9-]+-[A-Za-z0-9_-]+$/);
      expect(ids.senderItemId).toMatch(/^[a-z0-9-]+-[a-f0-9]{40}$/);
    }
    expect(() =>
      payoutIds({ instanceId: "p1", source: "lab", sourceId: "x", technicianKey: "maya", attempt: 0 }),
    ).toThrow();
  });

  it("rejects a sender_item_id without the instance prefix or over 63 characters", async () => {
    const { client: c } = client([]);
    await expect(createPayout(c, { ...PAYOUT, senderItemId: "other-1" })).rejects.toThrow(/sender_item_id/);
    await expect(createPayout(c, { ...PAYOUT, senderItemId: `t-unit-${"x".repeat(60)}` })).rejects.toThrow(
      /sender_item_id/,
    );
  });

  it("classifies payout errors and terminal item statuses", () => {
    expect(payoutErrorOutcome(new PayPalNetworkError("timeout"))).toBe("unknown");
    expect(payoutErrorOutcome(new PayPalApiError({ status: 503 }))).toBe("unknown");
    expect(payoutErrorOutcome(new PayPalApiError({ status: 422, errorName: "INSUFFICIENT_FUNDS" }))).toBe("definite");
    expect(
      payoutErrorOutcome(
        new PayPalApiError({
          status: 400,
          errorName: "USER_BUSINESS_ERROR",
          details: [{ field: "SENDER_BATCH_ID", issue: "Batch with given sender_batch_id already exists" }],
          links: [{ href: "https://api.sandbox.paypal.com/v1/payments/payouts/ABC123" }],
        }),
      ),
    ).toBe("recover_duplicate");
    expect(payoutItemOutcome("REFUNDED")).toBe("needs_review");
    expect(payoutItemOutcome("REVERSED")).toBe("needs_review");
  });

  it("never auto-retries invoice create; recovers by searching OUR number", async () => {
    const { client: c, calls } = client([
      { match: (r) => r.url.endsWith("/v2/invoicing/invoices"), respond: () => new TypeError("socket hang up") },
      {
        match: (r) => r.url.includes("/v2/invoicing/search-invoices"),
        respond: () =>
          json(200, {
            total_pages: 1,
            items: [
              {
                id: "INV2-RCVR",
                status: "DRAFT",
                detail: { invoice_number: INVOICE_INPUT.invoiceNumber, currency_code: "USD" },
              },
            ],
          }),
      },
    ]);
    await expect(createInvoice(c, INVOICE_INPUT)).resolves.toEqual({
      id: "INV2-RCVR",
      status: "DRAFT",
      recovered: true,
    });
    expect(api(calls).filter((r) => r.url.endsWith("/v2/invoicing/invoices"))).toHaveLength(1);
    expect(api(calls).filter((r) => r.url.includes("search-invoices"))).toHaveLength(1);
  });

  it("keeps an unknown create outcome unknown when the search finds nothing", async () => {
    const { client: c } = client([
      {
        match: (r) => r.url.endsWith("/v2/invoicing/invoices"),
        respond: () => json(503, { name: "SERVICE_UNAVAILABLE" }),
      },
      { match: (r) => r.url.includes("search-invoices"), respond: () => json(200, { total_pages: 1, items: [] }) },
    ]);
    const error = await createInvoice(c, INVOICE_INPUT).catch((e) => e);
    expect(isUnknownOutcome(error)).toBe(true);
  });

  it("treats a search with more pages and no match as unknown, not 'not found'", async () => {
    const { client: c } = client([
      { match: (r) => r.url.includes("search-invoices"), respond: () => json(200, { total_pages: 3, items: [] }) },
    ]);
    await expect(findInvoiceByNumber(c, "t-unit-X")).rejects.toBeInstanceOf(PayPalNetworkError);
  });

  it("requires the instance prefix on invoice numbers", async () => {
    const { client: c } = client([]);
    await expect(createInvoice(c, { ...INVOICE_INPUT, invoiceNumber: "p1-HL7K3Q9-X1" })).rejects.toThrow(
      /instance prefix/,
    );
  });

  it("computes totals and enforces the $2,000 cap and positive amounts", () => {
    expect(invoiceTotalCents(INVOICE_INPUT.items)).toBe(4000);
    expect(() =>
      invoiceBody({ ...INVOICE_INPUT, items: [{ name: "x", quantity: 1, unitAmountCents: 200_001 }] }),
    ).toThrow(/cap/);
    expect(() => invoiceBody({ ...INVOICE_INPUT, items: [{ name: "x", quantity: 1, unitAmountCents: 0 }] })).toThrow(
      /positive/,
    );
    expect(() =>
      invoiceBody({
        ...INVOICE_INPUT,
        maxTotalCents: 300_000,
        items: [{ name: "x", quantity: 1, unitAmountCents: 250_000 }],
      }),
    ).not.toThrow();
  });

  it("cancel: a failed request on an already-cancelled invoice counts as success", async () => {
    const { client: c, calls } = client([
      { match: (r) => r.url.endsWith("/cancel"), respond: () => new TypeError("ECONNRESET") },
      {
        match: (r) => r.method === "GET",
        respond: () => json(200, { id: "INV2-X", status: "CANCELLED", detail: { currency_code: "USD" } }),
      },
    ]);
    await expect(cancelInvoice(c, "INV2-X")).resolves.toBeUndefined();
    expect(api(calls).filter((r) => r.url.endsWith("/cancel"))).toHaveLength(1);
  });
});
