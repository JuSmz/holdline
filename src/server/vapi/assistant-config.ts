import { BUSINESS } from "@/db/seed-data";
import { AGENT_TOOLS, type ToolDefinition } from "@/server/agent/tools";
import { vapiPromptTemplate } from "@/server/agent/prompt";

/**
 * Saved Vapi configuration (SPEC §14.1), built here and applied by scripts/vapi-setup.ts.
 * Stage 7: the four real agent tools and the shared prompt core (one source for voice and chat).
 */

export const ASSISTANT_NAME = "Holdline";
export const CREDENTIAL_NAME = "holdline-webhook";

/** Accepted by the API but missing from the published schema, so it is sent separately and verified by GET. */
export const SILENCE_TIMEOUT_SECONDS = 240;

export type SetupInput = {
  appUrl: string;
  credentialId: string;
  provider: string;
  model: string;
  maxTokens: number;
  temperature: number;
  maxCallSeconds: number;
  instanceId: string;
};

export const TOOL_DEFINITIONS: ToolDefinition[] = AGENT_TOOLS;

export function toolBody(def: ToolDefinition, input: Pick<SetupInput, "appUrl" | "credentialId">) {
  return {
    type: "function",
    async: false,
    function: { name: def.name, description: def.description, parameters: def.parameters },
    server: { url: `${input.appUrl}/api/vapi/tools`, credentialId: input.credentialId, timeoutSeconds: 10 },
    messages: [
      { type: "request-start", content: def.startLine },
      { type: "request-response-delayed", content: "Still on it, one moment.", timingMilliseconds: 3000 },
    ],
  };
}

/** The demo and transcription notice (SPEC §21). The business is the seeded main workspace. */
export const FIRST_MESSAGE =
  "Thanks for calling Northside Plumbing & Electric. This is a demo line and calls are transcribed, so please use made-up details. How can I help?";

export const SYSTEM_PROMPT = vapiPromptTemplate(BUSINESS.name);

export function assistantBody(input: SetupInput, toolIds: string[]) {
  return {
    name: ASSISTANT_NAME,
    firstMessage: FIRST_MESSAGE,
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: input.provider,
      model: input.model,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      toolIds,
      tools: [{ type: "endCall" }],
      messages: [{ role: "system", content: SYSTEM_PROMPT }],
    },
    voice: { provider: "vapi", voiceId: "Elliot" },
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    server: { url: `${input.appUrl}/api/vapi/events`, credentialId: input.credentialId, timeoutSeconds: 10 },
    serverMessages: ["tool-calls", "status-update", "end-of-call-report"],
    clientMessages: ["transcript", "speech-update", "status-update", "hang"],
    monitorPlan: { controlEnabled: true, listenEnabled: false },
    artifactPlan: { recordingEnabled: false, videoRecordingEnabled: false, pcapEnabled: false },
    maxDurationSeconds: input.maxCallSeconds,
    hooks: [
      {
        on: "customer.speech.timeout",
        options: { timeoutSeconds: 30, triggerMaxCount: 3, triggerResetMode: "onUserSpeech" },
        do: [{ type: "say", exact: ["Take your time — I'm still here.", "No rush, I'm still on the line."] }],
      },
    ],
    metadata: { app: "holdline", instance: input.instanceId },
  };
}
