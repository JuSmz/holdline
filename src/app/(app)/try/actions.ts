"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getDb } from "@/db/client";
import { clientIp } from "@/server/security/client-ip";
import { ipHash } from "@/server/security/rate-limit";
import { createDemoWorkspace, DemoLimitError } from "@/server/workspaces/demo";
import { WORKSPACE_COOKIE, workspaceCookieOptions, workspaceCookieValue } from "@/server/workspaces/session";

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
