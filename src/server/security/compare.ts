import { createHash, timingSafeEqual } from "node:crypto";

import { MIN_SECRET_LENGTH } from "@/server/config/env";

/** Constant-time string comparison (hashes first, so lengths don't leak). */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/**
 * Checks an `Authorization: Bearer <token>` header against the expected secret.
 * An empty or too-short expected secret never authenticates anything.
 */
export function bearerMatches(header: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || expected.length < MIN_SECRET_LENGTH) return false;
  if (!header) return false;
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) return false;
  return safeEqual(match[1], expected);
}
