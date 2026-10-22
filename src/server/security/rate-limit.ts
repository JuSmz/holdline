import { createHmac } from "node:crypto";

import { sql } from "drizzle-orm";

import { rateCounters } from "@/db/schema";
import type { Executor } from "@/db/types";
import { readSecret } from "@/server/config/env";

/** `life`: one bucket for the key's whole life (e.g. turns per chat), kept for 60 days. */
export type RateWindow = "minute" | "hour" | "day" | "life";

const WINDOW_MS: Record<RateWindow, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  life: 30 * 86_400_000,
};

/** The UTC bucket a moment falls into, e.g. `2026-10-22T13` for an hour. */
export function windowKey(window: RateWindow, now: Date): string {
  if (window === "life") return "life";
  const iso = now.toISOString();
  return window === "day" ? iso.slice(0, 10) : window === "hour" ? iso.slice(0, 13) : iso.slice(0, 16);
}

/**
 * Atomic fixed-window counter (SPEC §20): `INSERT … ON CONFLICT (scope, key, window) DO UPDATE SET n = n + 1
 * RETURNING n`. Returns whether this call is within `limit`; the attempt is counted either way.
 */
export async function consume(
  db: Executor,
  input: { scope: string; key: string; window: RateWindow; limit: number; now: Date; amount?: number },
): Promise<{ ok: boolean; n: number; remaining: number }> {
  const amount = input.amount ?? 1;
  const bucket = windowKey(input.window, input.now);
  const [row] = await db
    .insert(rateCounters)
    .values({
      scope: input.scope,
      key: input.key,
      window: bucket,
      n: amount,
      expiresAt: new Date(input.now.getTime() + 2 * WINDOW_MS[input.window]),
    })
    .onConflictDoUpdate({
      target: [rateCounters.scope, rateCounters.key, rateCounters.window],
      set: { n: sql`${rateCounters.n} + ${amount}` },
    })
    .returning({ n: rateCounters.n });
  return { ok: row.n <= input.limit, n: row.n, remaining: Math.max(0, input.limit - row.n) };
}

/** The current count without changing it (for "remaining today" displays). */
export async function peek(
  db: Executor,
  input: { scope: string; key: string; window: RateWindow; now: Date },
): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select n from rate_counters where scope = ${input.scope} and key = ${input.key} and "window" = ${windowKey(input.window, input.now)}`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * A keyed hash of the client address (SPEC §20): IPv4 as is, IPv6 by its /64 prefix. Never the raw IP.
 * Requests without a client address (local, private network) share the key "internal".
 */
export function ipHash(ip: string | null, env: Record<string, string | undefined> = process.env): string {
  if (!ip) return "internal";
  const secret = readSecret(env, "SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.trim());
  const normalized = mapped ? mapped[1] : ip.includes(":") ? ipv6Prefix64(ip) : ip.trim();
  return createHmac("sha256", secret).update(`ip:${normalized}`).digest("base64url").slice(0, 24);
}

/** The first four hextets of an IPv6 address, after expanding `::` (and an embedded IPv4 tail). */
export function ipv6Prefix64(ip: string): string {
  const address = ip.trim().toLowerCase().replace(/%.*$/, "");
  const [head, tail] = address.includes("::") ? address.split("::", 2) : [address, null];
  const toGroups = (part: string) =>
    part === ""
      ? []
      : part.split(":").flatMap((g) => {
          if (!g.includes(".")) return [g];
          const o = g.split(".").map(Number); // IPv4 in the last 32 bits
          return [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
        });
  const left = toGroups(head);
  const right = tail === null ? [] : toGroups(tail);
  const groups =
    tail === null ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return groups
    .slice(0, 4)
    .map((g) => (Number.parseInt(g || "0", 16) || 0).toString(16))
    .join(":");
}
