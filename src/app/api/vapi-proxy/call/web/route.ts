import { getDb } from "@/db/client";
import { readVar } from "@/server/config/env";
import { readCookie } from "@/server/security/cookies";
import { clientIp } from "@/server/security/client-ip";
import { ipHash } from "@/server/security/rate-limit";
import { attachVapiCall, CALLER_COOKIE, callerFromCookie, reserveWebCall, VoiceBusyError } from "@/server/try/web-call";
import { answerWebCall, createVapiWebCall } from "@/server/vapi/web-call";
import { tryApiGuard } from "@/server/workspaces/guard";

export const dynamic = "force-dynamic";

/**
 * The /try web-call proxy for `new Vapi("proxy", origin + "/api/vapi-proxy")` (SPEC §14.3): the demo
 * workspace cookie, the pre-call form cookie, and the caps reserved atomically before Vapi is called.
 * The client body is discarded; the server picks the assistant and the variables. Every exit that ends
 * without a bound call gives the reservation back. The owner lab has its own route (/lab/call/web).
 */
export async function POST(request: Request) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const caller = callerFromCookie(readCookie(request, CALLER_COOKIE), guard.ws.id);
  if (!caller) return Response.json({ ok: false, error: "form_required" }, { status: 400 });
  if (!readVar(process.env, "VAPI_ASSISTANT_ID")) {
    return Response.json({ ok: false, error: "VAPI_ASSISTANT_ID_NOT_SET" }, { status: 503 });
  }

  let reservation;
  try {
    reservation = await reserveWebCall(getDb(), {
      workspaceId: guard.ws.id,
      ipKey: ipHash(clientIp(request.headers)),
      caller: { firstName: caller.firstName, email: caller.email },
      now: new Date(),
    });
  } catch (error) {
    if (error instanceof VoiceBusyError) {
      return Response.json(
        { ok: false, error: "voice_busy", reason: error.reason, message: error.message },
        { status: 429 },
      );
    }
    throw error;
  }

  let response: Response | null = null;
  try {
    const created = await createVapiWebCall({ channel: "web", first_name: caller.firstName, email: caller.email });
    if (created instanceof Response) return (response = created);
    const { call } = created;
    response = await answerWebCall(created, () =>
      attachVapiCall(getDb(), reservation.callRowId, {
        vapiCallId: call.id,
        type: call.type ?? null,
        controlUrl: call.monitor?.controlUrl ?? null,
        status: call.status ?? "queued",
        llmModel: call.assistant?.model?.model ?? null,
      }),
    );
    return response;
  } finally {
    if (!response || response.status !== 201) await reservation.undo();
  }
}
