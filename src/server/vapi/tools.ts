import { sendControl } from "./control";
import { findCallBinding, recordVapiEvent } from "./calls";
import { toolCallsOf, type ToolCall, type ToolResult, type VapiServerMessage } from "./messages";

/**
 * Stage-4 spike catalog for the one dummy tool. Fixed on the server like the PayPal lab amounts
 * (SPEC §9.1); stage 8 replaces it with the workspace's services from the database.
 */
const LAB_CATALOG = [
  {
    category: "plumbing",
    service: {
      service_id: "lab-drain",
      name: "Drain cleaning",
      description: "Clear one blocked sink, shower or floor drain.",
      price: "$149.00",
      duration_min: 90,
      no_show_fee: "$49.00",
    },
  },
  {
    category: "electrical",
    service: {
      service_id: "lab-outlet",
      name: "Outlet or switch repair",
      description: "Diagnose and repair one faulty outlet or switch.",
      price: "$129.00",
      duration_min: 60,
      no_show_fee: "$39.00",
    },
  },
  {
    category: "any",
    service: {
      service_id: "lab-diagnostic",
      name: "Diagnostic visit",
      description: "A technician finds the cause and quotes the fix on site.",
      price: "$89.00",
      duration_min: 60,
      no_show_fee: "$29.00",
    },
  },
] as const;

function runTool(call: ToolCall): ToolResult {
  const base = { toolCallId: call.id, name: call.name };
  if (call.args === null) return { ...base, error: "invalid_arguments" };
  switch (call.name) {
    case "get_services": {
      const category = call.args.category;
      const services = LAB_CATALOG.filter(
        (entry) => entry.category === "any" || category === undefined || entry.category === category,
      ).map((entry) => entry.service);
      return { ...base, result: JSON.stringify({ services }) };
    }
    default:
      return { ...base, error: "unknown_tool" };
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
    results = toolCalls.map(runTool);
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
