import { dbErrorCode } from "@/server/db-error";
import { recordVapiEvent } from "@/server/vapi/calls";
import { answerToolCalls, toolErrorResponse } from "@/server/vapi/tools";
import { readVapiWebhook } from "@/server/vapi/webhook";

export const dynamic = "force-dynamic";

/**
 * The function tools' server URL (SPEC §14.5). Always 200 with one result per toolCallId,
 * also when our database fails (logged as a code only: the error message carries the payload).
 */
export async function POST(request: Request) {
  const webhook = await readVapiWebhook(request);
  if (!webhook.ok) return webhook.response;
  const { message, raw } = webhook;

  await recordVapiEvent({
    endpoint: "tools",
    messageType: message.type,
    vapiCallId: message.call?.id,
    callType: message.call?.type,
    payload: raw,
  });

  if (message.type !== "tool-calls") return Response.json({ results: [] });
  try {
    return Response.json(await answerToolCalls(message, "tools"));
  } catch (error) {
    console.error(`[holdline] Vapi tool-calls for ${message.call?.id ?? "?"} failed: ${dbErrorCode(error)}`);
    return Response.json(toolErrorResponse(message));
  }
}
