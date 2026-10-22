import { after } from "next/server";

import { getDb } from "@/db/client";
import { dbErrorCode } from "@/server/db-error";
import { syncWorkspacePayouts } from "@/server/dashboard/payouts";
import { dashboardState } from "@/server/dashboard/queries";
import { defaultContext } from "@/server/payments/context";
import { tryApiGuard, type Workspace } from "@/server/workspaces/guard";

export const dynamic = "force-dynamic";

/**
 * Polled every 3 s by the owner dashboard while it is visible (SPEC §18). Scoped to the demo workspace
 * of the cookie. It answers from the database right away; after the response it follows payouts PayPal
 * is still processing (at most once per 5 s per workspace), so the next poll shows "Paid out" without a
 * reload, and a slow PayPal never holds up the page.
 */
export async function GET(request: Request) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  let response: Response;
  try {
    const state = await dashboardState(getDb(), guard.ws, new Date());
    response = Response.json({ ok: true, ...state }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error(`[holdline] dashboard state failed: ${dbErrorCode(error)}`);
    response = Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
  syncAfterResponse(guard.ws);
  return response;
}

/** Runs the payout sync after the response (inside a request), otherwise in the background. Logged only. */
function syncAfterResponse(ws: Workspace): void {
  const run = () =>
    syncWorkspacePayouts(defaultContext(), ws).then(
      () => undefined,
      (error: unknown) => console.error(`[holdline] dashboard payout sync skipped: ${dbErrorCode(error)}`),
    );
  try {
    after(run);
  } catch {
    void run();
  }
}
