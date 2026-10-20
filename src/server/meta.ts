import { eq, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { appMeta } from "@/db/schema";

const LAST_TICK = "last_tick_at";

/** Records the job heartbeat. Returns the stored timestamp. */
export async function recordTick(db: Db, at: Date = new Date()): Promise<Date> {
  await db
    .insert(appMeta)
    .values({ key: LAST_TICK, value: at.toISOString(), updatedAt: at })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: at.toISOString(), updatedAt: at } });
  return at;
}

export async function getLastTick(db: Db): Promise<Date | null> {
  const rows = await db.select({ value: appMeta.value }).from(appMeta).where(eq(appMeta.key, LAST_TICK)).limit(1);
  const value = rows[0]?.value;
  return typeof value === "string" ? new Date(value) : null;
}

/** Cheap connectivity check. Logs the underlying reason (never the connection URL) on failure. */
export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    console.error(`[holdline] database ping failed: ${cause?.code ?? "unknown"} ${cause?.message ?? ""}`.trim());
    return false;
  }
}
