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

/** Owner sessions: random server-side IDs created by POST login with ADMIN_TOKEN (SPEC §20). */
export const adminSessions = pgTable("admin_sessions", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
