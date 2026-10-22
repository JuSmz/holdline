/**
 * The four agent tools (SPEC §13.2). Flat schemas: primitives and enums only, no anyOf/oneOf, so they
 * work the same as Vapi function tools and as Gemini functionDeclarations.
 */

export type ToolName =
  "get_services" | "check_availability" | "create_booking_with_payment_link" | "check_payment_status";

export type ToolDefinition = {
  name: ToolName;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
  /** What the voice agent says while the tool runs (SPEC §14.1). */
  startLine: string;
};

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "get_services",
    description:
      "Lists the services this business offers with their fixed price, typical duration and no-show fee. Call it before quoting any price.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["plumbing", "electrical"],
          description: "The trade of the caller's problem.",
        },
        urgent: { type: "boolean", description: "True if the caller needs help today." },
      },
      required: [],
    },
    startLine: "Let me pull up our prices.",
  },
  {
    name: "check_availability",
    description:
      "Finds up to three free appointment windows for a service, starting on the preferred date. Offer only these, by their labels.",
    parameters: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "service_id from get_services." },
        preferred_date: { type: "string", description: "Preferred day as YYYY-MM-DD in Austin time." },
        time_of_day: { type: "string", enum: ["morning", "afternoon", "any"] },
        urgent: { type: "boolean" },
      },
      required: ["service_id", "preferred_date"],
    },
    startLine: "Checking the schedule.",
  },
  {
    name: "create_booking_with_payment_link",
    description:
      "Books the chosen slot and puts a PayPal hold button in front of the customer. Call it once the caller picked a slot and you have their details. Calling it again with another service or slot replaces the earlier booking.",
    parameters: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        slot_id: { type: "string", description: "slot_id from check_availability." },
        customer_name: { type: "string" },
        customer_email: { type: "string" },
        customer_phone: { type: "string" },
        service_address: { type: "string" },
        problem_summary: { type: "string", description: "One or two sentences about the problem." },
        urgency: { type: "string", enum: ["emergency", "soon", "flexible"] },
      },
      required: [
        "service_id",
        "slot_id",
        "customer_name",
        "customer_email",
        "service_address",
        "problem_summary",
        "urgency",
      ],
    },
    startLine: "Setting that up and sending the PayPal button.",
  },
  {
    name: "check_payment_status",
    description: "Checks whether the customer's PayPal hold went through. Use it when they ask about the payment.",
    parameters: {
      type: "object",
      properties: {
        booking_ref: { type: "string", description: "Optional; defaults to this conversation's booking." },
      },
      required: [],
    },
    startLine: "Let me check with PayPal.",
  },
];

export function isToolName(name: string): name is ToolName {
  return AGENT_TOOLS.some((tool) => tool.name === name);
}
