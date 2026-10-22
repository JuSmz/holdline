import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { bookings, calls, workspaces } from "@/db/schema";
import { readCookie } from "@/server/security/cookies";
import { isSameOrigin } from "@/server/security/same-origin";

import { WORKSPACE_COOKIE, workspaceIdFromCookie } from "./session";

export type Workspace = typeof workspaces.$inferSelect;

const deny = (status: number, error: string) => Response.json({ ok: false, error }, { status });

/**
 * Guard for /api/try, /api/chat and the demo dashboard (SPEC §17, §20): the signed workspace cookie,
 * plus the Origin check on anything that changes state. Reads the Cookie header itself so route
 * handlers stay testable without Next's request scope.
 */
export async function tryApiGuard(request: Request): Promise<{ ws: Workspace } | Response> {
  if (request.method !== "GET" && !isSameOrigin(request)) return deny(403, "bad_origin");
  const id = workspaceIdFromCookie(readCookie(request, WORKSPACE_COOKIE));
  if (!id) return deny(401, "no_demo_workspace");
  const [ws] = await getDb().select().from(workspaces).where(eq(workspaces.id, id));
  if (!ws || ws.kind !== "demo") return deny(401, "no_demo_workspace");
  return { ws };
}

/** A booking of this workspace, or null. Bookings are never addressed across workspaces. */
export async function workspaceBooking(ws: Workspace, bookingId: string) {
  if (!/^[0-9a-f-]{36}$/.test(bookingId)) return null;
  const [row] = await getDb()
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.workspaceId, ws.id)));
  return row ?? null;
}

/** A conversation (web call or chat) of this workspace, or null. */
export async function workspaceCall(ws: Workspace, callId: string) {
  if (!/^[0-9a-f-]{36}$/.test(callId)) return null;
  const [row] = await getDb()
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.workspaceId, ws.id)));
  return row ?? null;
}

/** A web call of this workspace by its Vapi call ID (the browser SDK only knows that one). */
export async function workspaceVapiCall(ws: Workspace, vapiCallId: string) {
  if (!/^[A-Za-z0-9-]{8,100}$/.test(vapiCallId)) return null;
  const [row] = await getDb()
    .select()
    .from(calls)
    .where(and(eq(calls.vapiCallId, vapiCallId), eq(calls.workspaceId, ws.id)));
  return row ?? null;
}
