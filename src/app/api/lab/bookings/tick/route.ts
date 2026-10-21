import { getDb } from "@/db/client";
import { labApiGuard } from "@/server/lab";
import { recordTick } from "@/server/meta";
import { defaultContext } from "@/server/payments/context";
import { paymentErrorResponse } from "@/server/payments/http";
import { runTick } from "@/server/payments/jobs";

export const dynamic = "force-dynamic";

/** Runs one job tick now, so the lab doesn't wait for the 5-minute cron (SPEC §12). */
export async function POST(request: Request) {
  const denied = await labApiGuard(request);
  if (denied) return denied;
  try {
    const report = await runTick(defaultContext(), getDb());
    await recordTick(getDb());
    return Response.json({ ok: true, report });
  } catch (error) {
    return paymentErrorResponse(error);
  }
}
