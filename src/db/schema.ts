import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The Holdline data model (SPEC §7). All primary keys are UUIDv7 (native `uuidv7()` in Postgres 18),
 * money is integer cents in USD, timestamps are timestamptz. Business tables carry `workspace_id`.
 */

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const workspaceKind = pgEnum("workspace_kind", ["main", "demo", "phone_demo"]);

/** Per-workspace rules (SPEC §7); missing keys fall back to `DEFAULT_POLICY` in src/server/domain/policy.ts. */
export type WorkspacePolicy = {
  cancellationWindowHours?: number;
  holdTtlMinutes?: number;
  staleHoldHours?: number;
  bookingWindowDays?: number;
};

export const workspaces = pgTable("workspaces", {
  id: id(),
  kind: workspaceKind("kind").notNull(),
  label: text("label").notNull(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  policy: jsonb("policy").$type<WorkspacePolicy>().notNull().default({}),
  sandboxBuyerIndex: integer("sandbox_buyer_index"),
  createdAt: createdAt(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Small key/value table for app-wide facts such as the job heartbeat (`last_tick_at`). */
export const appMeta = pgTable("app_meta", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per PayPal API call (no PII, no secrets). Feeds the "PayPal activity" feed
 * and the sandbox report. Written fire-and-forget by the PayPal client.
 */
export const paypalApiLog = pgTable(
  "paypal_api_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    op: text("op").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    httpStatus: integer("http_status"),
    requestId: text("request_id"),
    resourceIds: jsonb("resource_ids").$type<Record<string, string>>().notNull().default({}),
    resourceStatus: text("resource_status"),
    debugId: text("debug_id"),
    issue: text("issue"),
    attempts: integer("attempts").notNull().default(1),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [index("paypal_api_log_at_idx").on(t.at)],
);

/** Verified PayPal webhook events. Unverified requests are never stored (SPEC §11). */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    paypalEventId: text("paypal_event_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    summary: text("summary"),
    raw: jsonb("raw").$type<unknown>().notNull(),
    simulated: boolean("simulated").notNull().default(false),
    verifiedVia: text("verified_via").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    /** A short processing lease (stage 6): no transaction is held open while a handler runs. */
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
  },
  (t) => [index("webhook_events_received_idx").on(t.receivedAt)],
);

export const callChannel = pgEnum("call_channel", ["web", "phone", "chat"]);

/**
 * One row per conversation (SPEC §7). Stage 4 creates it for voice calls: the server-side
 * binding that webhooks and tools are scoped by. `control_url` is never sent to the client.
 */
export const calls = pgTable(
  "calls",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channel: callChannel("channel").notNull(),
    vapiCallId: text("vapi_call_id").unique(),
    vapiCallType: text("vapi_call_type"),
    /** Started from the owner lab (stage 4 spike), not from /try or the phone line. */
    lab: boolean("lab").notNull().default(false),
    controlUrl: text("control_url"),
    status: text("status").notNull().default("created"),
    llmModel: text("llm_model"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationS: integer("duration_s"),
    transcript: text("transcript"),
    messages: jsonb("messages").$type<unknown>(),
    /** Vapi's `artifact.performanceMetrics` (turn latencies) from the end-of-call report. */
    metrics: jsonb("metrics").$type<unknown>(),
    costCents: integer("cost_cents"),
    endedReason: text("ended_reason"),
    /** Text chat (stage 7): the session ID instead of a Vapi call ID. */
    chatSessionId: text("chat_session_id").unique(),
    /** HMAC of the caller's number (phone calls); never the number itself. */
    callerHash: text("caller_hash"),
    /** Raw Gemini `Content[]` of a chat, stored verbatim (SPEC §15). */
    geminiContents: jsonb("gemini_contents").$type<unknown[]>(),
    summary: jsonb("summary").$type<unknown>(),
    /** Read-only sample history in a cloned demo workspace (SPEC §17). */
    sample: boolean("sample").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("calls_created_idx").on(t.createdAt), index("calls_workspace_idx").on(t.workspaceId, t.createdAt)],
);

/**
 * Authenticated Vapi webhook payloads and our web-call create responses, kept raw as fixtures
 * (stage 4) and for debugging. Contains transcripts: purged with the call data (SPEC §21).
 */
export const vapiEvents = pgTable(
  "vapi_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`uuidv7()`),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    endpoint: text("endpoint").notNull(),
    messageType: text("message_type").notNull(),
    vapiCallId: text("vapi_call_id"),
    callType: text("call_type"),
    payload: jsonb("payload").$type<unknown>().notNull(),
  },
  (t) => [index("vapi_events_received_idx").on(t.receivedAt), index("vapi_events_call_idx").on(t.vapiCallId)],
);

/** Owner sessions: random server-side IDs created by POST login with ADMIN_TOKEN (SPEC §20). */
export const adminSessions = pgTable("admin_sessions", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// ─── Catalog ───────────────────────────────────────────────────────────────────────────────────────

export const serviceCategory = pgEnum("service_category", ["plumbing", "electrical"]);

export const services = pgTable(
  "services",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Stable key from seed-data.ts, so clones and re-seeds line up. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    category: serviceCategory("category").notNull(),
    description: text("description").notNull(),
    priceCents: integer("price_cents").notNull(),
    durationMin: integer("duration_min").notNull(),
    noShowFeeCents: integer("no_show_fee_cents").notNull(),
    isEmergency: boolean("is_emergency").notNull().default(false),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("services_workspace_key_uq").on(t.workspaceId, t.key)],
);

export const addonItems = pgTable(
  "addon_items",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    unit: text("unit").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("addon_items_workspace_key_uq").on(t.workspaceId, t.key)],
);

/** Weekly hours in the workspace timezone: ISO weekday (1 = Monday) → [["08:00", "18:00"], …]. */
export type WorkingHours = Partial<Record<"1" | "2" | "3" | "4" | "5" | "6" | "7", [string, string][]>>;

export const technicians = pgTable(
  "technicians",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    skills: serviceCategory("skills").array().notNull(),
    /** A sandbox personal account, from env (SPEC §7). Null until configured. */
    payoutEmail: text("payout_email"),
    /** 6000 = 60 % of recognised money (SPEC §9.1). */
    payoutShareBps: integer("payout_share_bps").notNull(),
    workingHours: jsonb("working_hours").$type<WorkingHours>().notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [uniqueIndex("technicians_workspace_key_uq").on(t.workspaceId, t.key)],
);

/** PII, purged after 14 days (SPEC §21): the row stays, the fields are blanked and `purged_at` set. */
export const customers = pgTable("customers", {
  id: id(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  createdAt: createdAt(),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
});

// ─── Bookings and the state machine (SPEC §8) ────────────────────────────────────────────────────

export const bookingStatus = pgEnum("booking_status", [
  "pending_payment",
  "authorized",
  "completed",
  "no_show",
  "cancelled",
  "captured",
  "voided",
  "expired",
  "paid_out",
]);

export const paymentIssue = pgEnum("payment_issue", [
  "authorization_pending",
  "reauth_failed",
  "hold_lost",
  "capture_failed",
  "capture_pending",
  "payout_failed",
]);

export const urgency = pgEnum("urgency", ["emergency", "soon", "flexible"]);
export const bookingActor = pgEnum("booking_actor", ["agent", "owner", "customer", "system", "webhook"]);

export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** `HL-` + 5 Crockford base32 characters, globally unique (SPEC §10.4). */
    ref: text("ref").notNull().unique(),
    status: bookingStatus("status").notNull().default("pending_payment"),
    paymentIssue: paymentIssue("payment_issue"),
    version: integer("version").notNull().default(0),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id),
    customerId: uuid("customer_id").references(() => customers.id),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
    slotStart: timestamp("slot_start", { withTimezone: true }).notNull(),
    slotEnd: timestamp("slot_end", { withTimezone: true }).notNull(),
    // Price snapshot (SPEC §9.1): every amount is derived from these, never from the live catalog.
    serviceName: text("service_name").notNull(),
    priceCents: integer("price_cents").notNull(),
    noShowFeeCents: integer("no_show_fee_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    problemSummary: text("problem_summary"),
    urgency: urgency("urgency").notNull().default("flexible"),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }).notNull(),
    /** Set by the authorize claim (SPEC §9.2); the TTL job leaves the booking alone while it is in the future. */
    authorizingUntil: timestamp("authorizing_until", { withTimezone: true }),
    activeAuthorizationId: uuid("active_authorization_id").references((): AnyPgColumn => authorizations.id),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    /** expired: ttl | withdrawn | superseded. cancelled: owner | late | hold_timeout. */
    cancelReason: text("cancel_reason"),
    /** Read-only sample history in a cloned demo workspace; jobs and owner actions skip it. */
    sample: boolean("sample").notNull().default(false),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bookings_workspace_slot_idx").on(t.workspaceId, t.slotStart),
    index("bookings_status_idx").on(t.status),
    // A technician's slot can be held by one live booking only (SPEC §8.4.5).
    uniqueIndex("bookings_live_slot_uq")
      .on(t.technicianId, t.slotStart)
      .where(sql`status in ('pending_payment', 'authorized') and not sample`),
  ],
);

/** Append-only audit log of every status change and flag change (SPEC §8). */
export const bookingEvents = pgTable(
  "booking_events",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    fromStatus: bookingStatus("from_status"),
    toStatus: bookingStatus("to_status"),
    /** `+capture_failed` / `-capture_failed`, or a note such as `orphan_void`. */
    flag: text("flag"),
    actor: bookingActor("actor").notNull(),
    reason: text("reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("booking_events_booking_idx").on(t.bookingId, t.at)],
);

export const bookingClaims = pgTable("booking_claims", {
  id: id(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  bookingId: uuid("booking_id")
    .notNull()
    .unique()
    .references(() => bookings.id, { onDelete: "cascade" }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const payTokenPurpose = pgEnum("pay_token_purpose", ["email_link", "device_link"]);

/** Pay links: random 32-byte tokens; only the hash is stored (SPEC §20). */
export const payTokens = pgTable("pay_tokens", {
  id: id(),
  bookingId: uuid("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  purpose: payTokenPurpose("purpose").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ─── PayPal objects ───────────────────────────────────────────────────────────────────────────────

export const paypalOrders = pgTable(
  "paypal_orders",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    paypalOrderId: text("paypal_order_id").notNull().unique(),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("paypal_orders_booking_attempt_uq").on(t.bookingId, t.attempt)],
);

export const authorizationRole = pgEnum("authorization_role", ["active", "replaced", "orphan"]);

export const authorizations = pgTable(
  "authorizations",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    paypalAuthorizationId: text("paypal_authorization_id").notNull().unique(),
    /** Set on a reauthorization: the chain's parent, which is the one voids go to (SPEC §9.5). */
    parentAuthorizationId: uuid("parent_authorization_id").references((): AnyPgColumn => authorizations.id),
    paypalOrderId: text("paypal_order_id"),
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    honorUntil: timestamp("honor_until", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    reauthorizeAt: timestamp("reauthorize_at", { withTimezone: true }),
    role: authorizationRole("role").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("authorizations_booking_idx").on(t.bookingId)],
);

export const captureKind = pgEnum("capture_kind", ["full", "no_show_fee", "late_cancel_fee"]);

export const captures = pgTable(
  "captures",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    authorizationId: uuid("authorization_id")
      .notNull()
      .references(() => authorizations.id),
    paypalCaptureId: text("paypal_capture_id").notNull().unique(),
    kind: captureKind("kind").notNull(),
    amountCents: integer("amount_cents").notNull(),
    finalCapture: boolean("final_capture").notNull(),
    status: text("status").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("captures_booking_idx").on(t.bookingId)],
);

export const invoiceKind = pgEnum("invoice_kind", ["extra_work", "fallback"]);
export const invoiceStatus = pgEnum("invoice_status", ["draft", "sent", "paid", "cancelled"]);

/** An invoice line as snapshotted at creation (SPEC §9.6). */
export type InvoiceItemSnapshot = { key: string | null; name: string; quantity: number; unitAmountCents: number };

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    /** Null until PayPal's create returns (or search-invoices recovers it). */
    paypalInvoiceId: text("paypal_invoice_id").unique(),
    /** Our own number, stored BEFORE the create call: the dedup key, since Invoicing ignores request IDs. */
    invoiceNumber: text("invoice_number").notNull().unique(),
    seq: integer("seq").notNull(),
    kind: invoiceKind("kind").notNull(),
    status: invoiceStatus("status").notNull().default("draft"),
    items: jsonb("items").$type<InvoiceItemSnapshot[]>().notNull(),
    totalCents: integer("total_cents").notNull(),
    paidCents: integer("paid_cents").notNull().default(0),
    payerViewUrl: text("payer_view_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("invoices_booking_seq_uq").on(t.bookingId, t.seq)],
);

export const payoutSource = pgEnum("payout_source", ["capture", "invoice"]);
export const payoutStatus = pgEnum("payout_status", [
  "pending",
  "processing",
  "unclaimed",
  "cancelling",
  "succeeded",
  "failed",
  "needs_review",
]);

export const payouts = pgTable(
  "payouts",
  {
    id: id(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    source: payoutSource("source").notNull(),
    /** Our captures.id or invoices.id. */
    sourceId: uuid("source_id").notNull(),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id),
    attemptNo: integer("attempt_no").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    senderBatchId: text("sender_batch_id").notNull().unique(),
    senderItemId: text("sender_item_id").notNull(),
    paypalBatchId: text("paypal_batch_id"),
    paypalItemId: text("paypal_item_id"),
    status: payoutStatus("status").notNull().default("pending"),
    /** PayPal's raw item status, e.g. UNCLAIMED or ONHOLD. */
    transactionStatus: text("transaction_status"),
    sample: boolean("sample").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The natural key (SPEC §9.9): webhook, job and sync path can never create two.
    uniqueIndex("payouts_natural_key_uq").on(t.source, t.sourceId, t.technicianId, t.attemptNo),
    index("payouts_booking_idx").on(t.bookingId),
  ],
);

export const operationState = pgEnum("operation_state", ["in_flight", "succeeded", "failed"]);

/** The idempotency ledger (SPEC §10.3). */
export const paymentOperations = pgTable(
  "payment_operations",
  {
    id: id(),
    key: text("key").notNull().unique(),
    kind: text("kind").notNull(),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    paypalRequestId: text("paypal_request_id"),
    state: operationState("state").notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(1),
    lastError: text("last_error"),
    result: jsonb("result").$type<unknown>(),
    /**
     * Set once the reconciler has confirmed that a succeeded operation's result is reflected in the
     * domain tables (or re-applied it). Covers a crash between PayPal's answer and our DB write.
     */
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("payment_operations_inflight_idx").on(t.state, t.leaseUntil),
    index("payment_operations_unapplied_idx").on(t.state, t.appliedAt),
  ],
);

// ─── Notifications, email, rate limits ────────────────────────────────────────────────────────────

export const notifyVia = pgEnum("notify_via", ["server", "browser", "chat"]);

export const callNotifications = pgTable(
  "call_notifications",
  {
    id: id(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    channel: text("channel").notNull(),
    via: notifyVia("via"),
    ok: boolean("ok"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("call_notifications_uq").on(t.bookingId, t.status, t.channel)],
);

export const outboxStatus = pgEnum("outbox_status", ["pending", "sent", "failed", "outbox_only"]);

export const outboxEmails = pgTable(
  "outbox_emails",
  {
    id: id(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
    toHmac: text("to_hmac").notNull(),
    /** Null when the mail is shown in the demo outbox only. PII, purged per §21. */
    to: text("to"),
    template: text("template").notNull(),
    subject: text("subject").notNull(),
    html: text("html"),
    status: outboxStatus("status").notNull().default("pending"),
    resendId: text("resend_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("outbox_emails_status_idx").on(t.status, t.createdAt)],
);

export const emailIdentities = pgTable("email_identities", {
  id: id(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  email: text("email"),
  emailHmac: text("email_hmac").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  confirmTokenHash: text("confirm_token_hash"),
  createdAt: createdAt(),
});

export const suppressionReason = pgEnum("suppression_reason", ["bounce", "complaint"]);

export const emailSuppressions = pgTable("email_suppressions", {
  id: id(),
  emailHmac: text("email_hmac").notNull().unique(),
  reason: suppressionReason("reason").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

/** Atomic counters: INSERT … ON CONFLICT (scope, key, window) DO UPDATE SET n = n + 1 (SPEC §20). */
export const rateCounters = pgTable(
  "rate_counters",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    window: text("window").notNull(),
    n: integer("n").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("rate_counters_uq").on(t.scope, t.key, t.window)],
);
