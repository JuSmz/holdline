import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

type Handle = { url: string; sql: postgres.Sql; db: Db };

// Created lazily on first use — never at module scope — so builds and imports
// don't open connections or need DATABASE_URL.
let handle: Handle | undefined;

export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

export function getDb(): Db {
  const url = databaseUrl();
  if (!handle || handle.url !== url) {
    // Render's internal URL needs no TLS; pool size stays small on a 512 MB instance.
    const sql = postgres(url, { max: 5, idle_timeout: 20, connect_timeout: 5 });
    handle = { url, sql, db: drizzle(sql, { schema }) };
  }
  return handle.db;
}

/** Closes the pool (tests and scripts). */
export async function closeDb(): Promise<void> {
  const current = handle;
  handle = undefined;
  await current?.sql.end({ timeout: 5 });
}
