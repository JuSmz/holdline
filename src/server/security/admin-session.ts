import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";

import { getDb } from "@/db/client";
import { adminSessions } from "@/db/schema";

/** Owner session cookie: random ID, only its SHA-256 is stored (SPEC §20). */
export const ADMIN_COOKIE = "__Host-hl_admin";
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const hash = (id: string) => createHash("sha256").update(id).digest("hex");

export async function createAdminSession(now = new Date()): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_MS);
  await getDb()
    .insert(adminSessions)
    .values({ id: hash(id), expiresAt });
  return { id, expiresAt };
}

export async function isValidAdminSession(id: string | undefined, now = new Date()): Promise<boolean> {
  if (!id || id.length > 100) return false;
  const rows = await getDb()
    .select({ id: adminSessions.id })
    .from(adminSessions)
    .where(and(eq(adminSessions.id, hash(id)), gt(adminSessions.expiresAt, now)))
    .limit(1);
  return rows.length === 1;
}

export async function deleteAdminSession(id: string | undefined): Promise<void> {
  if (!id) return;
  await getDb()
    .delete(adminSessions)
    .where(eq(adminSessions.id, hash(id)));
}

export function adminCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}
