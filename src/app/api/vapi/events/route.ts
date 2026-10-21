import { dbErrorCode } from "@/server/db-error";
import { applyCallReport, applyCallStatus, findCallBinding, recordVapiEvent } from "@/server/vapi/calls";
import { reportOf, statusOf, type VapiServerMessage } from "@/server/vapi/messages";
import { answerToolCalls, endUnboundCall, toolErrorResponse } from "@/server/vapi/tools";
import { readVapiWebhook } from "@/server/vapi/webhook";

export const dynamic = "force-dynamic";

async function handle(message: VapiServerMessage): Promise<void> {
  const callId = message.call?.id;
  switch (message.type) {
    case "status-update": {
      const status = statusOf(message);
      if (!callId || !status) return;
      const binding = await findCallBinding(callId);
      if (!binding) {
        if (status.status === "in-progress") await endUnboundCall(message, "status-update");
        return;
      }
      await applyCallStatus(callId, status.status, message.call?.monitor?.controlUrl);
      return;
    }
    case "end-of-call-report": {
      const report = reportOf(message);
      if (callId && report) await applyCallReport(callId, report);
      return;
    }
  }
}

/**
 * The assistant's server URL (SPEC §14.5): status updates, end-of-call reports, and tool calls
 * if Vapi routes them here instead of the tool's own URL. Every authenticated payload is kept as a fixture.
 * Database errors are caught and logged as codes only: their messages carry transcripts and controlUrls.
 */
export async function POST(request: Request) {
  const webhook = await readVapiWebhook(request);
  if (!webhook.ok) return webhook.response;
  const { message, raw } = webhook;

  await recordVapiEvent({
    endpoint: "events",
    messageType: message.type,
    vapiCallId: message.call?.id,
    callType: message.call?.type,
    payload: raw,
  });

  if (message.type === "tool-calls") {
    try {
      return Response.json(await answerToolCalls(message, "events"));
    } catch (error) {
      console.error(`[holdline] Vapi tool-calls for ${message.call?.id ?? "?"} failed: ${dbErrorCode(error)}`);
      return Response.json(toolErrorResponse(message));
    }
  }
  try {
    await handle(message);
  } catch (error) {
    console.error(`[holdline] Vapi ${message.type} for ${message.call?.id ?? "?"} failed: ${dbErrorCode(error)}`);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
