import { eq } from "drizzle-orm";
import { cookies } from "next/headers";

import { getDb } from "@/db/client";
import { workspaces } from "@/db/schema";
import { sign, verify } from "@/server/security/tokens";

/** The visitor's demo workspace cookie (SPEC §20): `__Host-`, HttpOnly, Secure, Lax, 30 days. */
export const WORKSPACE_COOKIE = "__Host-hl_ws";
export const WORKSPACE_COOKIE_TTL_SECONDS = 30 * 24 * 3600;

export function workspaceCookieValue(workspaceId: string, now = new Date()): string {
  return sign("ws-cookie", { ws: workspaceId }, WORKSPACE_COOKIE_TTL_SECONDS, { now });
}

export function workspaceCookieOptions(now = new Date()) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    expires: new Date(now.getTime() + WORKSPACE_COOKIE_TTL_SECONDS * 1000),
  };
}

export function workspaceIdFromCookie(value: string | undefined): string | null {
  const claims = verify<{ ws?: unknown }>("ws-cookie", value);
  return typeof claims?.ws === "string" ? claims.ws : null;
}

/** The visitor's demo workspace from the signed cookie, or null (no cookie, forged, expired, or deleted). */
export async function currentDemoWorkspace() {
  const id = workspaceIdFromCookie((await cookies()).get(WORKSPACE_COOKIE)?.value);
  if (!id) return null;
  const [ws] = await getDb().select().from(workspaces).where(eq(workspaces.id, id));
  return ws && ws.kind === "demo" ? ws : null;
}
