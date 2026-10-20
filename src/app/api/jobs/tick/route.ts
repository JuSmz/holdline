import { getDb } from "@/db/client";
import { readSecret } from "@/server/config/env";
import { recordTick } from "@/server/meta";
import { bearerMatches } from "@/server/security/compare";

export const dynamic = "force-dynamic";

/**
 * Called every 5 minutes by the Render cron job over the private network.
 * Stage 1: only records the heartbeat. The jobs from SPEC §12 are added in stage 6.
 */
export async function POST(request: Request) {
  const secret = readSecret(process.env, "CRON_SECRET");
  if (!secret) {
    return Response.json({ ok: false, error: "cron_not_configured" }, { status: 503 });
  }
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const at = await recordTick(getDb());
  return Response.json({ ok: true, at: at.toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
