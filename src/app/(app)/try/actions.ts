"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { getDb } from "@/db/client";
import { dbErrorCode } from "@/server/db-error";
import { configuredContext } from "@/server/payments/context";
import { clientIp } from "@/server/security/client-ip";
import { ipHash } from "@/server/security/rate-limit";
import { CALLER_COOKIE } from "@/server/try/web-call";
import { createDemoWorkspace, DemoLimitError } from "@/server/workspaces/demo";
import {
  endDemoWorkspaceCalls,
  markDemoWorkspaceReset,
  purgeDemoWorkspacePii,
  releaseDemoWorkspaceHolds,
} from "@/server/workspaces/reset";
import {
  currentDemoWorkspace,
  WORKSPACE_COOKIE,
  workspaceCookieDeletion,
  workspaceCookieOptions,
  workspaceCookieValue,
} from "@/server/workspaces/session";

export type StartState = { error: string | null };

/** "Start the demo" (SPEC §17): a POST with Next's Origin check; GET /try never creates anything. */
export async function startDemo(): Promise<StartState> {
  const now = new Date();
  try {
    const ws = await createDemoWorkspace(getDb(), { ipKey: ipHash(clientIp(await headers())), now });
    (await cookies()).set(WORKSPACE_COOKIE, workspaceCookieValue(ws.id, now), workspaceCookieOptions(now));
  } catch (error) {
    if (error instanceof DemoLimitError) return { error: error.message };
    throw error;
  }
  redirect("/try");
}

/**
 * "Start a fresh demo" (SPEC §17, §21): ends a live web call of this copy, hard-deletes its PII now and
 * marks it reset (dead for the guard and for late writers), releases its open holds without a fee
 * (after the response, so the redirect isn't held up by PayPal), and drops the cookie. The tick
 * repeats the purge and the release for an hour. The visitor lands on the start card for a new copy.
 */
export async function resetDemo(): Promise<void> {
  const ws = await currentDemoWorkspace();
  if (ws) {
    const db = getDb();
    try {
      // Best effort and bounded (3 s): the assistant stops listening before its transcript is purged.
      await endDemoWorkspaceCalls(db, ws.id);
    } catch (error) {
      console.error(`[holdline] reset: ending calls of workspace ${ws.id} failed: ${dbErrorCode(error)}`);
    }
    try {
      await purgeDemoWorkspacePii(db, ws.id, new Date());
    } catch (error) {
      // Codes only (§21). The copy is still marked reset, so the guard drops it and the tick's backstop
      // purges it; one more try right after the response too.
      console.error(`[holdline] reset: PII purge for workspace ${ws.id} failed: ${dbErrorCode(error)}`);
      await markDemoWorkspaceReset(db, ws.id, new Date()).catch((mark: unknown) =>
        console.error(`[holdline] reset: marking workspace ${ws.id} failed: ${dbErrorCode(mark)}`),
      );
      after(() =>
        purgeDemoWorkspacePii(db, ws.id, new Date()).catch((retry: unknown) =>
          console.error(`[holdline] reset: PII purge retry for workspace ${ws.id} failed: ${dbErrorCode(retry)}`),
        ),
      );
    }
    after(async () => {
      try {
        // configuredContext (defaultContext plus an up-front PayPal check): without PayPal no booking
        // is touched, so the tick's reset backstop (or the stale-hold job) can still release it later.
        await releaseDemoWorkspaceHolds(configuredContext(), ws.id);
      } catch (error) {
        console.error(`[holdline] reset: releasing holds for workspace ${ws.id} failed: ${dbErrorCode(error)}`);
      }
    });
  }
  const jar = await cookies();
  // With the original attributes: a bare delete(name) has no Secure, and the browser keeps the cookie.
  jar.delete(workspaceCookieDeletion());
  // The short-lived pre-call form cookie carries the caller's name and email.
  if (jar.has(CALLER_COOKIE)) {
    jar.delete({ name: CALLER_COOKIE, path: "/", secure: true, httpOnly: true, sameSite: "strict" });
  }
  redirect("/try?fresh=1");
}
