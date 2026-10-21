import { z } from "zod";

import { dbErrorCode } from "@/server/db-error";
import { labApiGuard } from "@/server/lab";
import { findLabCall } from "@/server/vapi/calls";
import { VapiApiError, VapiNotConfiguredError } from "@/server/vapi/client";
import { sendPaymentNotice } from "@/server/vapi/notify";

export const dynamic = "force-dynamic";

const input = z.object({
  callId: z.string().regex(/^[A-Za-z0-9-]{8,100}$/),
  notice: z.enum(["authorized", "declined_retry", "expired"]),
});

/** "Simulate payment" in the voice lab: the server `say` + `add-message` through the controlUrl (SPEC §16). */
export async function POST(request: Request) {
  const denied = await labApiGuard(request);
  if (denied) return denied;

  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });

  try {
    const binding = await findLabCall(parsed.data.callId);
    if (!binding) return Response.json({ ok: false, error: "no_live_lab_call" }, { status: 404 });
    const started = performance.now();
    const outcome = await sendPaymentNotice(binding, parsed.data.notice, "HL-LAB01");
    // OK only if both landed: the model's context must match what the caller heard (SPEC §16).
    const ok = Boolean(outcome.say?.ok && outcome.addMessage?.ok);
    return Response.json({ ok, totalMs: Math.round(performance.now() - started), ...outcome });
  } catch (error) {
    if (error instanceof VapiApiError || error instanceof VapiNotConfiguredError) {
      return Response.json({ ok: false, error: error.message }, { status: 502 });
    }
    // A database error message would carry the controlUrl; log the code only.
    console.error(`[holdline] lab notice for ${parsed.data.callId} failed: ${dbErrorCode(error)}`);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
