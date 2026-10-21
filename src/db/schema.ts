import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Stage 1 schema: workspaces + app metadata.
 * All primary keys are UUIDv7 (native `uuidv7()` in Postgres 18).
 * The full model (SPEC §7) arrives in stage 5.
 */

export const workspaceKind = pgEnum("workspace_kind", ["main", "demo", "phone_demo"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  kind: workspaceKind("kind").notNull(),
  label: text("label").notNull(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  policy: jsonb("policy").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
      .references(() => workspaces.id),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("calls_created_idx").on(t.createdAt)],
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
