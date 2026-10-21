import { z } from "zod";

/** The parts of Vapi's `POST /call/web` response we read. */
export const webCallResponseSchema = z
  .object({
    id: z.string().min(1).max(100),
    type: z.string().max(50).optional(),
    status: z.string().max(50).optional(),
    webCallUrl: z.string().url().max(2000),
    monitor: z.object({ controlUrl: z.string().optional() }).loose().optional(),
    transport: z.object({ provider: z.string().optional(), callToken: z.string().optional() }).loose().optional(),
    artifactPlan: z.object({ videoRecordingEnabled: z.boolean().optional() }).loose().optional(),
    assistant: z
      .object({
        voice: z.object({ provider: z.string().optional() }).loose().optional(),
        model: z
          .object({ model: z.string().max(100).optional() })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export type WebCallResponse = z.infer<typeof webCallResponseSchema>;

/**
 * What the browser gets back: only the fields @vapi-ai/web 3.0.0 reads to join the room
 * (`id`, `webCallUrl`, `transport.callToken`, `artifactPlan.videoRecordingEnabled`,
 * `assistant.voice.provider`). The controlUrl, the prompt and the tool config stay on the server.
 */
export function projectWebCall(call: WebCallResponse) {
  return {
    id: call.id,
    webCallUrl: call.webCallUrl,
    transport: {
      provider: call.transport?.provider,
      ...(call.transport?.callToken ? { callToken: call.transport.callToken } : {}),
    },
    artifactPlan: { videoRecordingEnabled: call.artifactPlan?.videoRecordingEnabled ?? false },
    assistant: { voice: { provider: call.assistant?.voice?.provider } },
  };
}
