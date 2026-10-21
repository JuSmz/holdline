import { MAIN_WORKSPACE_ID } from "@/db/seed";
import { readVar } from "@/server/config/env";
import { dbErrorCode } from "@/server/db-error";
import { labApiGuard } from "@/server/lab";
import { bindWebCall, recordVapiEvent } from "@/server/vapi/calls";
import { getVapiWebCallClient, VapiApiError, VapiNotConfiguredError } from "@/server/vapi/client";
import { projectWebCall, webCallResponseSchema } from "@/server/vapi/web-call";

export const dynamic = "force-dynamic";

/**
 * Web-call proxy for `new Vapi("proxy", origin + "/api/vapi-proxy")` (SPEC §14.3). The client body
 * is discarded: the server picks the assistant and its variables and calls Vapi with the server-only
 * public key (`/call/web` rejects the private key).
 * Stage 4: owner lab only. Stage 8 adds the /try workspace cookie and the caps.
 */
export async function POST(request: Request) {
  const denied = await labApiGuard(request);
  if (denied) return denied;

  const assistantId = readVar(process.env, "VAPI_ASSISTANT_ID");
  if (!assistantId) return Response.json({ ok: false, error: "VAPI_ASSISTANT_ID_NOT_SET" }, { status: 503 });

  let raw: unknown;
  try {
    raw = await getVapiWebCallClient().post("/call/web", {
      assistantId,
      assistantOverrides: {
        variableValues: { channel: "web", first_name: "Lab", email: "lab-caller@example.com" },
      },
    });
  } catch (error) {
    if (error instanceof VapiNotConfiguredError)
      return Response.json({ ok: false, error: error.message }, { status: 503 });
    if (error instanceof VapiApiError) {
      return Response.json(
        { ok: false, error: "vapi_error", status: error.status, detail: error.detail },
        { status: 502 },
      );
    }
    throw error;
  }

  const parsed = webCallResponseSchema.safeParse(raw);
  if (!parsed.success) {
    await recordVapiEvent({ endpoint: "proxy", messageType: "call.web.unexpected", payload: raw });
    return Response.json({ ok: false, error: "unexpected_vapi_response" }, { status: 502 });
  }
  const call = parsed.data;

  // Bind before answering: the browser joins only after this response, so the binding exists
  // before Vapi's first in-progress status-update (an unbound in-progress call gets ended).
  try {
    await bindWebCall({
      workspaceId: MAIN_WORKSPACE_ID,
      vapiCallId: call.id,
      vapiCallType: call.type ?? null,
      controlUrl: call.monitor?.controlUrl ?? null,
      status: call.status ?? "queued",
      llmModel: call.assistant?.model?.model ?? null,
      lab: true,
    });
  } catch (error) {
    // Logged as a code only: the error message would carry the live controlUrl. The browser never
    // joins this call, and if anything does, the unbound in-progress call is ended.
    console.error(`[holdline] could not bind Vapi call ${call.id}: ${dbErrorCode(error)}`);
    return Response.json({ ok: false, error: "bind_failed" }, { status: 500 });
  }
  await recordVapiEvent({
    endpoint: "proxy",
    messageType: "call.web.created",
    vapiCallId: call.id,
    callType: call.type,
    payload: raw,
  });

  return Response.json(projectWebCall(call), { status: 201 });
}
