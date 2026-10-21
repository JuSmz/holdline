/**
 * A fake PayPal sandbox behind the real client (SPEC §10.2 `mock/`): it answers the same HTTP API the
 * client calls, keeps state in memory, replays responses by PayPal-Request-Id like PayPal does, and
 * takes scripted outcomes and faults. Used by the integration tests and by PAYPAL_MODE=mock.
 *
 * Behaviour follows what the real sandbox showed in stages 2–3 (docs/sandbox-report.md):
 * order create → PAYER_ACTION_REQUIRED until approved; final_capture releases the rest (CAPTURED);
 * reauthorize inside 3 days → REAUTHORIZATION_TOO_SOON; a duplicate sender_batch_id → 400 with a
 * link to the original batch; Invoicing ignores request IDs and dedups on invoice_number.
 * Reauthorization chains (child capturable, parent voidable, child CANNOT_BE_VOIDED) follow SPEC §9.5
 * and are checked against the sandbox on or after 2026-10-26.
 */

type Json = Record<string, unknown>;
type Money = { currency_code: string; value: string };

export type FakeRequest = { method: string; path: string; requestId: string | null; body: Json | null };

export type FakeFault =
  /** Answer with this error without performing the operation. */
  | { kind: "http"; status: number; name?: string; issue?: string; message?: string }
  /** The connection fails before PayPal sees the request. */
  | { kind: "network" }
  /** PayPal performs the operation, then the response is lost (timeout after success). */
  | { kind: "lostResponse" }
  /** 409 PREVIOUS_REQUEST_IN_PROGRESS without performing. */
  | { kind: "inProgress" };

type Rule = { method: string; path: RegExp; fault: FakeFault; remaining: number };

type Authorization = {
  id: string;
  status: "CREATED" | "CAPTURED" | "DENIED" | "PARTIALLY_CAPTURED" | "VOIDED" | "PENDING";
  amountCents: number;
  capturedCents: number;
  currency: string;
  orderId: string;
  customId?: string;
  invoiceId?: string;
  createTime: Date;
  expirationTime: Date;
  parentId?: string;
  childId?: string;
};

type Capture = {
  id: string;
  authorizationId: string;
  status: "COMPLETED" | "DECLINED" | "PENDING" | "FAILED";
  amountCents: number;
  currency: string;
  finalCapture: boolean;
  invoiceId?: string;
  createTime: Date;
};

type Order = {
  id: string;
  status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED" | "VOIDED";
  amountCents: number;
  currency: string;
  customId?: string;
  invoiceId?: string;
  description?: string;
  authorizationId?: string;
};

type PayoutItem = {
  id: string;
  batchId: string;
  status: "PENDING" | "SUCCESS" | "FAILED" | "UNCLAIMED" | "RETURNED" | "ONHOLD" | "BLOCKED";
  amountCents: number;
  currency: string;
  receiver: string;
  senderItemId: string;
};

type Invoice = {
  id: string;
  number: string;
  status: "DRAFT" | "SENT" | "PAID" | "PARTIALLY_PAID" | "CANCELLED" | "PAYMENT_PENDING";
  totalCents: number;
  paidCents: number;
  currency: string;
};

const DAY = 24 * 3_600_000;
const BASE = "https://api-m.sandbox.paypal.com";
const cents = (value: string) => Math.round(Number(value) * 100);
const money = (c: number, currency: string): Money => ({ currency_code: currency, value: (c / 100).toFixed(2) });

class FakeResponse {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

const fail = (status: number, name: string, issue?: string, extra: Json = {}) =>
  new FakeResponse(status, {
    name,
    message: issue ?? name,
    debug_id: "fake-debug",
    ...(issue ? { details: [{ issue, description: issue }] } : {}),
    ...extra,
  });

export class FakePayPal {
  readonly orders = new Map<string, Order>();
  readonly authorizations = new Map<string, Authorization>();
  readonly captures = new Map<string, Capture>();
  readonly payoutBatches = new Map<string, { id: string; senderBatchId: string; itemIds: string[] }>();
  readonly payoutItems = new Map<string, PayoutItem>();
  readonly invoices = new Map<string, Invoice>();
  /** Every API request (OAuth excluded), in order. */
  readonly requests: FakeRequest[] = [];

  /** Scripted outcomes, consumed in order; the default applies when a queue is empty. */
  readonly next = {
    authorizationStatus: [] as Authorization["status"][],
    captureStatus: [] as Capture["status"][],
    payoutItemStatus: [] as PayoutItem["status"][],
  };

  private readonly replay = new Map<string, FakeResponse>();
  private rules: Rule[] = [];
  private seq = 0;
  private clock: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.clock = options.now ?? (() => new Date());
  }

  now(): Date {
    return this.clock();
  }

  setClock(now: () => Date) {
    this.clock = now;
  }

  /** Injects a fault for the next `times` matching requests. */
  fault(method: string, path: RegExp, fault: FakeFault, times = 1) {
    this.rules.push({ method, path, fault, remaining: times });
  }

  clearFaults() {
    this.rules = [];
  }

  /** Requests to a path pattern (OAuth excluded), e.g. to assert exactly one capture call. */
  calls(method: string, path: RegExp): FakeRequest[] {
    return this.requests.filter((r) => r.method === method && path.test(r.path));
  }

  // ── Test helpers that act as the buyer or as PayPal itself ──────────────────────────────────

  /** The buyer approves the order in the popup. */
  approve(orderId: string) {
    const order = this.mustOrder(orderId);
    if (order.status === "PAYER_ACTION_REQUIRED") order.status = "APPROVED";
  }

  /** PayPal settles a pending authorization or capture later. */
  settleAuthorization(id: string, status: "CREATED" | "DENIED") {
    const auth = this.authorizations.get(id);
    if (!auth) throw new Error(`no authorization ${id}`);
    auth.status = status;
  }

  settleCapture(id: string, status: "COMPLETED" | "DECLINED") {
    const capture = this.captures.get(id);
    if (!capture) throw new Error(`no capture ${id}`);
    capture.status = status;
    if (status === "DECLINED") {
      const auth = this.authorizations.get(capture.authorizationId);
      if (auth) auth.capturedCents -= capture.amountCents;
    }
  }

  /** PayPal (or the payer's bank) voids a hold behind our back. */
  voidExternally(authorizationId: string) {
    const auth = this.authorizations.get(authorizationId);
    if (auth) auth.status = "VOIDED";
  }

  setPayoutItemStatus(itemId: string, status: PayoutItem["status"]) {
    const item = this.payoutItems.get(itemId);
    if (!item) throw new Error(`no payout item ${itemId}`);
    item.status = status;
  }

  /** The recipient pays an invoice (in full unless `paidCents` says otherwise). */
  payInvoice(invoiceId: string, paidCents?: number) {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new Error(`no invoice ${invoiceId}`);
    invoice.paidCents = paidCents ?? invoice.totalCents;
    invoice.status = invoice.paidCents >= invoice.totalCents ? "PAID" : "PARTIALLY_PAID";
  }

  invoiceByNumber(number: string): Invoice | undefined {
    return [...this.invoices.values()].find((i) => i.number === number);
  }

  // ── The HTTP surface ────────────────────────────────────────────────────────────────────────

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin !== BASE) throw new TypeError(`fake PayPal: unexpected host ${url.origin}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const path = url.pathname;

    if (path === "/v1/oauth2/token") return json(200, { access_token: "fake-token", expires_in: 32_400 });

    const requestId = headers.get("paypal-request-id");
    let body: Json | null = null;
    if (typeof init?.body === "string" && init.body) body = JSON.parse(init.body) as Json;
    this.requests.push({ method, path: path + url.search, requestId, body });

    const rule = this.rules.find((r) => r.remaining > 0 && r.method === method && r.path.test(path));
    if (rule) rule.remaining -= 1;
    if (rule?.fault.kind === "network") throw new TypeError("fetch failed (fake network error)");
    if (rule?.fault.kind === "inProgress") {
      return toResponse(fail(409, "RESOURCE_CONFLICT", "PREVIOUS_REQUEST_IN_PROGRESS"));
    }
    if (rule?.fault.kind === "http") {
      return toResponse(fail(rule.fault.status, rule.fault.name ?? "UNPROCESSABLE_ENTITY", rule.fault.issue));
    }

    // PayPal replays the stored result for a repeated request ID (Invoicing does not honor it).
    const replayKey =
      requestId && method === "POST" && !path.startsWith("/v2/invoicing") ? `${path}#${requestId}` : null;
    let response = replayKey ? this.replay.get(replayKey) : undefined;
    if (!response) {
      response = this.route(method, path, body);
      if (replayKey && response.status < 500) this.replay.set(replayKey, response);
    }
    if (rule?.fault.kind === "lostResponse") throw new TypeError("fetch failed (fake: response lost after success)");
    return toResponse(response);
  }) as typeof globalThis.fetch;

  private route(method: string, path: string, body: Json | null): FakeResponse {
    let m: RegExpExecArray | null;
    if (method === "POST" && path === "/v2/checkout/orders") return this.createOrder(body);
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path)) && method === "GET") return this.getOrder(m[1]);
    if ((m = /^\/v2\/checkout\/orders\/([^/]+)\/authorize$/.exec(path)) && method === "POST")
      return this.authorize(m[1]);
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)$/.exec(path)) && method === "GET") return this.getAuth(m[1]);
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)\/capture$/.exec(path)) && method === "POST") {
      return this.capture(m[1], body);
    }
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)\/void$/.exec(path)) && method === "POST") return this.void(m[1]);
    if ((m = /^\/v2\/payments\/authorizations\/([^/]+)\/reauthorize$/.exec(path)) && method === "POST") {
      return this.reauthorize(m[1], body);
    }
    if ((m = /^\/v2\/payments\/captures\/([^/]+)$/.exec(path)) && method === "GET") return this.getCapture(m[1]);
    if (method === "POST" && path === "/v1/payments/payouts") return this.createPayout(body);
    if ((m = /^\/v1\/payments\/payouts\/([^/]+)$/.exec(path)) && method === "GET") return this.getBatch(m[1]);
    if ((m = /^\/v1\/payments\/payouts-item\/([^/]+)$/.exec(path)) && method === "GET") return this.getItem(m[1]);
    if ((m = /^\/v1\/payments\/payouts-item\/([^/]+)\/cancel$/.exec(path)) && method === "POST") {
      return this.cancelItem(m[1]);
    }
    if (method === "POST" && path === "/v2/invoicing/invoices") return this.createInvoice(body);
    if ((m = /^\/v2\/invoicing\/invoices\/([^/]+)$/.exec(path)) && method === "GET") return this.getInvoice(m[1]);
    if ((m = /^\/v2\/invoicing\/invoices\/([^/]+)\/send$/.exec(path)) && method === "POST")
      return this.sendInvoice(m[1]);
    if ((m = /^\/v2\/invoicing\/invoices\/([^/]+)\/cancel$/.exec(path)) && method === "POST") {
      return this.cancelInvoice(m[1]);
    }
    if (method === "POST" && path === "/v2/invoicing/search-invoices") return this.searchInvoices(body);
    return fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
  }

  private id(prefix: string, length = 17): string {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(length - prefix.length, "0")}`;
  }

  private mustOrder(id: string): Order {
    const order = this.orders.get(id);
    if (!order) throw new Error(`no order ${id}`);
    return order;
  }

  // ── Orders v2 ───────────────────────────────────────────────────────────────────────────────

  private createOrder(body: Json | null): FakeResponse {
    const unit = (body?.purchase_units as Json[] | undefined)?.[0];
    const amount = unit?.amount as Money | undefined;
    if (body?.intent !== "AUTHORIZE" || !amount) return fail(400, "INVALID_REQUEST", "MISSING_REQUIRED_PARAMETER");
    const order: Order = {
      id: this.id("O"),
      status: "PAYER_ACTION_REQUIRED",
      amountCents: cents(amount.value),
      currency: amount.currency_code,
      customId: unit?.custom_id as string | undefined,
      invoiceId: unit?.invoice_id as string | undefined,
      description: unit?.description as string | undefined,
    };
    this.orders.set(order.id, order);
    return new FakeResponse(200, this.orderJson(order));
  }

  private getOrder(id: string): FakeResponse {
    const order = this.orders.get(id);
    return order
      ? new FakeResponse(200, this.orderJson(order))
      : fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
  }

  private authorize(id: string): FakeResponse {
    const order = this.orders.get(id);
    if (!order) return fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    if (order.status === "COMPLETED") return fail(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_AUTHORIZED");
    if (order.status !== "APPROVED") return fail(422, "UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED");
    const now = this.now();
    const auth: Authorization = {
      id: this.id("A"),
      status: this.next.authorizationStatus.shift() ?? "CREATED",
      amountCents: order.amountCents,
      capturedCents: 0,
      currency: order.currency,
      orderId: order.id,
      customId: order.customId,
      invoiceId: order.invoiceId,
      createTime: now,
      expirationTime: new Date(now.getTime() + 29 * DAY),
    };
    this.authorizations.set(auth.id, auth);
    order.status = "COMPLETED";
    order.authorizationId = auth.id;
    return new FakeResponse(201, this.orderJson(order));
  }

  private orderJson(order: Order) {
    const auth = order.authorizationId ? this.authorizations.get(order.authorizationId) : undefined;
    return {
      id: order.id,
      status: order.status,
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: "default",
          custom_id: order.customId,
          invoice_id: order.invoiceId,
          description: order.description,
          amount: money(order.amountCents, order.currency),
          ...(auth
            ? {
                payments: {
                  authorizations: [this.authJson(auth)],
                  captures: [...this.captures.values()]
                    .filter((c) => {
                      const owner = this.authorizations.get(c.authorizationId);
                      return owner?.id === auth.id || owner?.parentId === auth.id;
                    })
                    .map((c) => this.captureJson(c)),
                },
              }
            : {}),
        },
      ],
      links: [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`, rel: "payer-action" }],
    };
  }

  // ── Payments v2 ─────────────────────────────────────────────────────────────────────────────

  private authJson(auth: Authorization) {
    return {
      id: auth.id,
      status: auth.status,
      amount: money(auth.amountCents, auth.currency),
      custom_id: auth.customId,
      invoice_id: auth.invoiceId,
      create_time: auth.createTime.toISOString(),
      update_time: this.now().toISOString(),
      expiration_time: auth.expirationTime.toISOString(),
      supplementary_data: { related_ids: { order_id: auth.orderId } },
      links: auth.parentId ? [{ href: `${BASE}/v2/payments/authorizations/${auth.parentId}`, rel: "up" }] : [],
    };
  }

  private getAuth(id: string): FakeResponse {
    const auth = this.authorizations.get(id);
    return auth ? new FakeResponse(200, this.authJson(auth)) : fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
  }

  private capture(id: string, body: Json | null): FakeResponse {
    const auth = this.authorizations.get(id);
    if (!auth) return fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    if (auth.status === "VOIDED") return fail(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_VOIDED");
    if (auth.status === "CAPTURED") return fail(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_CAPTURED");
    if (auth.status === "DENIED") return fail(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_DENIED");
    if (auth.status === "PENDING") return fail(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_PENDING");
    if (auth.childId) return fail(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_REAUTHORIZED");
    if (this.now() > auth.expirationTime) return fail(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_EXPIRED");
    const amount = body?.amount as Money | undefined;
    const want = amount ? cents(amount.value) : auth.amountCents - auth.capturedCents;
    if (want <= 0 || want > auth.amountCents - auth.capturedCents) {
      return fail(422, "UNPROCESSABLE_ENTITY", "MAX_CAPTURE_AMOUNT_EXCEEDED");
    }
    const finalCapture = body?.final_capture === true;
    const capture: Capture = {
      id: this.id("C"),
      authorizationId: auth.id,
      status: this.next.captureStatus.shift() ?? "COMPLETED",
      amountCents: want,
      currency: auth.currency,
      finalCapture,
      invoiceId: body?.invoice_id as string | undefined,
      createTime: this.now(),
    };
    this.captures.set(capture.id, capture);
    if (capture.status !== "DECLINED" && capture.status !== "FAILED") {
      auth.capturedCents += want;
      // final_capture releases whatever is left (observed in the sandbox, report row 6).
      auth.status = finalCapture || auth.capturedCents >= auth.amountCents ? "CAPTURED" : "PARTIALLY_CAPTURED";
      const parent = auth.parentId ? this.authorizations.get(auth.parentId) : undefined;
      if (parent && auth.status === "CAPTURED") parent.status = "CAPTURED";
    }
    return new FakeResponse(201, this.captureJson(capture));
  }

  private captureJson(capture: Capture) {
    return {
      id: capture.id,
      status: capture.status,
      amount: money(capture.amountCents, capture.currency),
      final_capture: capture.finalCapture,
      invoice_id: capture.invoiceId,
      create_time: capture.createTime.toISOString(),
      links: [{ href: `${BASE}/v2/payments/authorizations/${capture.authorizationId}`, rel: "up" }],
    };
  }

  private getCapture(id: string): FakeResponse {
    const capture = this.captures.get(id);
    return capture
      ? new FakeResponse(200, this.captureJson(capture))
      : fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
  }

  private void(id: string): FakeResponse {
    const auth = this.authorizations.get(id);
    if (!auth) return fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    if (auth.parentId) return fail(422, "UNPROCESSABLE_ENTITY", "CANNOT_BE_VOIDED");
    if (auth.status === "VOIDED") return fail(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_VOIDED");
    if (auth.status === "CAPTURED") return fail(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_CAPTURED");
    if (auth.status === "DENIED") return fail(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_DENIED");
    auth.status = "VOIDED";
    const child = auth.childId ? this.authorizations.get(auth.childId) : undefined;
    if (child && child.status !== "CAPTURED") child.status = "VOIDED";
    return new FakeResponse(200, this.authJson(auth));
  }

  private reauthorize(id: string, body: Json | null): FakeResponse {
    const auth = this.authorizations.get(id);
    if (!auth) return fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    if (auth.parentId || auth.childId) return fail(422, "UNPROCESSABLE_ENTITY", "REAUTHORIZATION_NOT_ALLOWED");
    if (auth.status !== "CREATED") return fail(422, "UNPROCESSABLE_ENTITY", `AUTHORIZATION_${auth.status}`);
    if (this.now().getTime() < auth.createTime.getTime() + 3 * DAY) {
      return fail(422, "UNPROCESSABLE_ENTITY", "REAUTHORIZATION_TOO_SOON");
    }
    const amount = body?.amount as Money | undefined;
    const child: Authorization = {
      id: this.id("R"),
      status: this.next.authorizationStatus.shift() ?? "CREATED",
      amountCents: amount ? cents(amount.value) : auth.amountCents,
      capturedCents: 0,
      currency: auth.currency,
      orderId: auth.orderId,
      customId: auth.customId,
      invoiceId: auth.invoiceId,
      createTime: this.now(),
      expirationTime: auth.expirationTime,
      parentId: auth.id,
    };
    this.authorizations.set(child.id, child);
    auth.childId = child.id;
    return new FakeResponse(201, this.authJson(child));
  }

  // ── Payouts v1 ──────────────────────────────────────────────────────────────────────────────

  private createPayout(body: Json | null): FakeResponse {
    const header = body?.sender_batch_header as Json | undefined;
    const senderBatchId = header?.sender_batch_id as string | undefined;
    const item = (body?.items as Json[] | undefined)?.[0];
    if (!senderBatchId || !item) return fail(400, "VALIDATION_ERROR", "MISSING_REQUIRED_PARAMETER");
    const existing = [...this.payoutBatches.values()].find((b) => b.senderBatchId === senderBatchId);
    if (existing) {
      return new FakeResponse(400, {
        name: "USER_BUSINESS_ERROR",
        message: "User business error.",
        debug_id: "fake-debug",
        details: [
          {
            field: "SENDER_BATCH_ID",
            location: "body",
            issue: "Batch with given sender_batch_id already exists",
            link: [{ href: `${BASE}/v1/payments/payouts/${existing.id}`, rel: "self", method: "GET" }],
          },
        ],
      });
    }
    const amount = item.amount as { value: string; currency: string };
    const batchId = this.id("B", 13);
    const payoutItem: PayoutItem = {
      id: this.id("I", 13),
      batchId,
      status: this.next.payoutItemStatus.shift() ?? "SUCCESS",
      amountCents: cents(amount.value),
      currency: amount.currency,
      receiver: item.receiver as string,
      senderItemId: item.sender_item_id as string,
    };
    this.payoutItems.set(payoutItem.id, payoutItem);
    this.payoutBatches.set(batchId, { id: batchId, senderBatchId, itemIds: [payoutItem.id] });
    return new FakeResponse(201, {
      batch_header: {
        payout_batch_id: batchId,
        batch_status: "PENDING",
        sender_batch_header: { sender_batch_id: senderBatchId },
      },
    });
  }

  private itemJson(item: PayoutItem) {
    return {
      payout_item_id: item.id,
      transaction_status: item.status,
      payout_batch_id: item.batchId,
      payout_item: {
        recipient_type: "EMAIL",
        amount: { value: (item.amountCents / 100).toFixed(2), currency: item.currency },
        receiver: item.receiver,
        sender_item_id: item.senderItemId,
      },
      ...(item.status === "FAILED" ? { errors: { name: "RECEIVER_UNREGISTERED" } } : {}),
    };
  }

  private getBatch(id: string): FakeResponse {
    const batch = this.payoutBatches.get(id);
    if (!batch) return fail(404, "INVALID_RESOURCE_ID", "INVALID_RESOURCE_ID");
    const items = batch.itemIds.map((i) => this.payoutItems.get(i)!);
    const settled = items.every((i) => i.status !== "PENDING" && i.status !== "ONHOLD");
    return new FakeResponse(200, {
      batch_header: {
        payout_batch_id: batch.id,
        batch_status: settled ? "SUCCESS" : "PROCESSING",
        sender_batch_header: { sender_batch_id: batch.senderBatchId },
      },
      items: items.map((i) => this.itemJson(i)),
    });
  }

  private getItem(id: string): FakeResponse {
    const item = this.payoutItems.get(id);
    return item ? new FakeResponse(200, this.itemJson(item)) : fail(404, "INVALID_RESOURCE_ID", "INVALID_RESOURCE_ID");
  }

  private cancelItem(id: string): FakeResponse {
    const item = this.payoutItems.get(id);
    if (!item) return fail(404, "INVALID_RESOURCE_ID", "INVALID_RESOURCE_ID");
    if (item.status === "RETURNED") return fail(400, "ITEM_ALREADY_CANCELLED");
    if (item.status !== "UNCLAIMED") return fail(400, "ITEM_CANCELLATION_FAILED");
    item.status = "RETURNED";
    return new FakeResponse(200, this.itemJson(item));
  }

  // ── Invoicing v2 ────────────────────────────────────────────────────────────────────────────

  private createInvoice(body: Json | null): FakeResponse {
    const detail = body?.detail as Json | undefined;
    const number = detail?.invoice_number as string | undefined;
    const currency = (detail?.currency_code as string | undefined) ?? "USD";
    if (!number) return fail(400, "INVALID_REQUEST", "MISSING_REQUIRED_PARAMETER");
    if (this.invoiceByNumber(number)) return fail(422, "UNPROCESSABLE_ENTITY", "DUPLICATE_INVOICE_NUMBER");
    const items = (body?.items as Json[] | undefined) ?? [];
    const totalCents = items.reduce((sum, i) => sum + Number(i.quantity) * cents((i.unit_amount as Money).value), 0);
    this.seq += 1;
    const n = String(this.seq).padStart(16, "0");
    const id = `INV2-${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}`;
    this.invoices.set(id, { id, number, status: "DRAFT", totalCents, paidCents: 0, currency });
    return new FakeResponse(201, { rel: "self", href: `${BASE}/v2/invoicing/invoices/${id}`, method: "GET" });
  }

  private invoiceJson(invoice: Invoice) {
    return {
      id: invoice.id,
      status: invoice.status,
      detail: {
        invoice_number: invoice.number,
        currency_code: invoice.currency,
        metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${invoice.id}` },
      },
      amount: money(invoice.totalCents, invoice.currency),
      ...(invoice.paidCents > 0 ? { payments: { paid_amount: money(invoice.paidCents, invoice.currency) } } : {}),
    };
  }

  private getInvoice(id: string): FakeResponse {
    const invoice = this.invoices.get(id);
    return invoice
      ? new FakeResponse(200, this.invoiceJson(invoice))
      : fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
  }

  private sendInvoice(id: string): FakeResponse {
    const invoice = this.invoices.get(id);
    if (!invoice) return fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    if (invoice.status === "DRAFT") invoice.status = "SENT";
    return new FakeResponse(200, {
      rel: "payer-view",
      href: `https://www.sandbox.paypal.com/invoice/p/#${invoice.id}`,
      method: "GET",
    });
  }

  private cancelInvoice(id: string): FakeResponse {
    const invoice = this.invoices.get(id);
    if (!invoice) return fail(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID");
    if (invoice.status === "PAID") return fail(422, "UNPROCESSABLE_ENTITY", "CANNOT_CANCEL_PAID_INVOICE");
    invoice.status = "CANCELLED";
    return new FakeResponse(204, null);
  }

  private searchInvoices(body: Json | null): FakeResponse {
    const number = body?.invoice_number as string | undefined;
    const items = [...this.invoices.values()].filter((i) => !number || i.number === number);
    return new FakeResponse(200, {
      items: items.map((i) => this.invoiceJson(i)),
      total_items: items.length,
      total_pages: 1,
    });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function toResponse(r: FakeResponse): Response {
  if (r.status === 204 || r.body === null) return new Response(null, { status: r.status });
  return json(r.status, r.body);
}
