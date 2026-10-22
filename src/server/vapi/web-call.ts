import { z } from "zod";

import { readVar } from "@/server/config/env";
import { dbErrorCode } from "@/server/db-error";

import { recordVapiEvent } from "./calls";
import { getVapiWebCallClient, VapiApiError, VapiNotConfiguredError } from "./client";

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

/**
 * `POST /call/web` with the server-only public key (`/call/web` rejects the private key) and the
 * server's own assistant and variables (SPEC §14.3). Returns the parsed call, or the response to send.
 */
export async function createVapiWebCall(
  variableValues: Record<string, string>,
): Promise<{ call: WebCallResponse; raw: unknown } | Response> {
  const assistantId = readVar(process.env, "VAPI_ASSISTANT_ID");
  if (!assistantId) return Response.json({ ok: false, error: "VAPI_ASSISTANT_ID_NOT_SET" }, { status: 503 });
  let raw: unknown;
  try {
    raw = await getVapiWebCallClient().post("/call/web", { assistantId, assistantOverrides: { variableValues } });
  } catch (error) {
    if (error instanceof VapiNotConfiguredError) {
      return Response.json({ ok: false, error: error.message }, { status: 503 });
    }
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
  return { call: parsed.data, raw };
}

/**
 * Binds the created call before answering (the browser joins only after this response, so the binding
 * exists before Vapi's first in-progress status-update), keeps the fixture, and returns the projection.
 */
export async function answerWebCall(
  created: { call: WebCallResponse; raw: unknown },
  bind: () => Promise<void>,
): Promise<Response> {
  const { call, raw } = created;
  try {
    await bind();
  } catch (error) {
    // A code only: the error message would carry the live controlUrl. The browser never joins this
    // call, and if anything does, the unbound in-progress call is ended.
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
