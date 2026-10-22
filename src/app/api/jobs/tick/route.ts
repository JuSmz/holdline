import { getDb } from "@/db/client";
import { readSecret } from "@/server/config/env";
import { recordTick } from "@/server/meta";
import { configuredContext, type PaymentContext } from "@/server/payments/context";
import { runTick } from "@/server/payments/jobs";
import { PayPalNotConfiguredError } from "@/server/paypal";
import { bearerMatches } from "@/server/security/compare";

export const dynamic = "force-dynamic";

/**
 * Called every 5 minutes by the Render cron job over the private network. Runs the jobs from SPEC §12
 * in order, then records the heartbeat. Without PayPal credentials only the PayPal-free jobs run.
 */
export async function POST(request: Request) {
  const secret = readSecret(process.env, "CRON_SECRET");
  if (!secret) {
    return Response.json({ ok: false, error: "cron_not_configured" }, { status: 503 });
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let ctx: PaymentContext | null = null;
  try {
    ctx = configuredContext();
  } catch (error) {
    if (!(error instanceof PayPalNotConfiguredError)) throw error;
  }
  const report = await runTick(ctx, getDb());
  const at = await recordTick(getDb());
  return Response.json({ ok: true, at: at.toISOString(), report }, { headers: { "Cache-Control": "no-store" } });
}
