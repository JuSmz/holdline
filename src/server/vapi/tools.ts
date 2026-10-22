import { agentCallOf, agentContext, runAgentTool, type AgentContext } from "@/server/agent/handlers";
import { isToolName } from "@/server/agent/tools";
import { dbErrorCode } from "@/server/db-error";

import { sendControl } from "./control";
import { type CallBinding, findCallBinding, recordVapiEvent } from "./calls";
import { toolCallsOf, type ToolCall, type ToolResult, type VapiServerMessage } from "./messages";

/** One Vapi tool call through the shared agent handlers; Vapi wants the result as a string (SPEC §14.5). */
async function runTool(ctx: AgentContext, binding: CallBinding, call: ToolCall): Promise<ToolResult> {
  const base = { toolCallId: call.id, name: call.name };
  if (call.args === null) return { ...base, error: "invalid_arguments" };
  if (!isToolName(call.name)) return { ...base, error: "unknown_tool" };
  try {
    const result = await runAgentTool(ctx, agentCallOf(binding), { id: call.id, name: call.name, args: call.args });
    return { ...base, result: JSON.stringify(result) };
  } catch (error) {
    console.error(`[holdline] tool ${call.name} failed on call ${binding.id}: ${dbErrorCode(error)}`);
    return { ...base, error: "server_error" };
  }
}

/**
 * Answers a `tool-calls` message: one result per toolCallId, always HTTP 200 (SPEC §14.5).
 * Calls are scoped by the server-side binding only; an unbound call gets errors and is ended.
 */
export async function answerToolCalls(
  message: VapiServerMessage,
  endpoint: "events" | "tools",
): Promise<{ results: ToolResult[] }> {
  const toolCalls = toolCallsOf(message);
  const binding = await findCallBinding(message.call?.id);
  let results: ToolResult[];
  if (!binding) {
    results = toolCalls.map((c) => ({ toolCallId: c.id, name: c.name, error: "call_not_bound" }));
    await endUnboundCall(message, "tool-calls");
  } else {
    const ctx = agentContext();
    results = [];
    // Sequential on purpose: two booking calls of one conversation must not race (SPEC §13.3).
    for (const call of toolCalls) results.push(await runTool(ctx, binding, call));
  }
  await recordVapiEvent({
    endpoint,
    messageType: "tool-calls.response",
    vapiCallId: message.call?.id,
    callType: message.call?.type,
    payload: { bound: Boolean(binding), results },
  });
  return { results };
}

/** One error result per tool call, for when our side fails (the call goes on; the model hears an error). */
export function toolErrorResponse(message: VapiServerMessage): { results: ToolResult[] } {
  return { results: toolCallsOf(message).map((c) => ({ toolCallId: c.id, name: c.name, error: "server_error" })) };
}

/** Ends a call we didn't create (e.g. started with a leaked public key or the dashboard's test button). */
export async function endUnboundCall(message: VapiServerMessage, trigger: string): Promise<void> {
  const controlUrl = message.call?.monitor?.controlUrl;
  const outcome = controlUrl ? await sendControl(controlUrl, { type: "end-call" }) : null;
  console.warn(
    `[holdline] unbound Vapi call ${message.call?.id ?? "?"} (${trigger}): end-call ${
      outcome ? `${outcome.ok ? "sent" : "failed"} (${outcome.status ?? outcome.error})` : "skipped, no controlUrl"
    }`,
  );
}
