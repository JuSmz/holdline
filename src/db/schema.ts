import { sql } from "drizzle-orm";
import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
