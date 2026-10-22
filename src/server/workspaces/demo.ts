import { randomInt } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { workspaces } from "@/db/schema";
import { BUSINESS, seedCatalog, seedSampleHistory } from "@/db/seed-data";
import { readVar } from "@/server/config/env";
import { consume } from "@/server/security/rate-limit";

/** Caps on creating demo copies (SPEC §17, §20): per visitor, then globally. */
export const DEMO_LIMITS = { perIpHour: 5, globalHour: 60, globalDay: 400 } as const;

export class DemoLimitError extends Error {
  constructor(readonly scope: "ip" | "global") {
    super(
      scope === "ip"
        ? "Too many demo copies from your network — try again in an hour."
        : "The demo is busy right now — please try again later.",
    );
    this.name = "DemoLimitError";
  }
}

export type SandboxBuyer = { email: string; password: string };

/** The US sandbox buyers shown to judges (SPEC §17); sandbox-only credentials, by design public. */
export function sandboxBuyers(env: Record<string, string | undefined> = process.env): SandboxBuyer[] {
  try {
    const parsed = JSON.parse(readVar(env, "SANDBOX_BUYERS") ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((b): b is SandboxBuyer => typeof b?.email === "string" && typeof b?.password === "string")
      .filter((b) => b.email.toLowerCase().endsWith(".example.com"));
  } catch {
    return [];
  }
}

export function buyerFor(
  index: number | null,
  env: Record<string, string | undefined> = process.env,
): SandboxBuyer | null {
  const buyers = sandboxBuyers(env);
  if (buyers.length === 0 || index === null) return null;
  return buyers[index % buyers.length];
}

/**
 * Creates a private demo copy for one visitor (SPEC §17): the Northside catalog, a sandbox buyer
 * assigned round-robin, and read-only sample history. Rate-limited per IP hash and globally.
 */
export async function createDemoWorkspace(db: Db, input: { ipKey: string; now: Date }) {
  const perIp = await consume(db, {
    scope: "demo-create",
    key: input.ipKey,
    window: "hour",
    limit: DEMO_LIMITS.perIpHour,
    now: input.now,
  });
  if (!perIp.ok) throw new DemoLimitError("ip");
  const hour = await consume(db, {
    scope: "demo-create",
    key: "global",
    window: "hour",
    limit: DEMO_LIMITS.globalHour,
    now: input.now,
  });
  const day = await consume(db, {
    scope: "demo-create",
    key: "global",
    window: "day",
    limit: DEMO_LIMITS.globalDay,
    now: input.now,
  });
  if (!hour.ok || !day.ok) throw new DemoLimitError("global");

  return db.transaction(async (tx) => {
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaces)
      .where(eq(workspaces.kind, "demo"));
    const [ws] = await tx
      .insert(workspaces)
      .values({
        kind: "demo",
        label: `#${randomInt(1000, 10_000)}`,
        name: BUSINESS.name,
        timezone: BUSINESS.timezone,
        sandboxBuyerIndex: n,
      })
      .returning();
    await seedCatalog(tx, ws.id);
    await seedSampleHistory(tx, ws.id, input.now);
    return ws;
  });
}

export async function getDemoWorkspace(db: Db, id: string) {
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, id), eq(workspaces.kind, "demo")));
  return ws ?? null;
}
