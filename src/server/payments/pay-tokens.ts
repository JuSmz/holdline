import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";

import { payTokens } from "@/db/schema";
import type { Executor } from "@/db/types";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Pay links (SPEC §20): random 32-byte tokens, only the hash is stored. `email_link` tokens expire at the
 * slot start; `device_link` tokens are minted on demand and single-use.
 */
export async function issuePayToken(
  db: Executor,
  input: { bookingId: string; purpose: "email_link" | "device_link"; expiresAt: Date },
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db
    .insert(payTokens)
    .values({ bookingId: input.bookingId, tokenHash: hash(token), purpose: input.purpose, expiresAt: input.expiresAt });
  return token;
}

/** A pay token that hasn't expired, used or not (the pay page shows a finished booking read-only). */
export async function findPayToken(db: Executor, token: string, now: Date) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await db
    .select()
    .from(payTokens)
    .where(and(eq(payTokens.tokenHash, hash(token)), gt(payTokens.expiresAt, now)));
  return row ?? null;
}

/** Marks a device link used once its payment step is done (single-use, SPEC §20). */
export async function spendDeviceToken(db: Executor, token: string, now: Date): Promise<void> {
  await db
    .update(payTokens)
    .set({ usedAt: now })
    .where(and(eq(payTokens.tokenHash, hash(token)), eq(payTokens.purpose, "device_link"), isNull(payTokens.usedAt)));
}
