import { readSecret } from "@/server/config/env";
import { readBodyLimited } from "@/server/paypal/webhooks";
import { bearerMatches } from "@/server/security/compare";

import { MAX_VAPI_BODY_BYTES, parseServerMessage, type VapiServerMessage } from "./messages";

export type VapiWebhook = { ok: true; message: VapiServerMessage; raw: unknown } | { ok: false; response: Response };

const reject = (status: number, error: string) => ({
  ok: false as const,
  response: Response.json({ ok: false, error }, { status }),
});

/**
 * Authenticates and parses a Vapi server message (SPEC §14.5): the saved Bearer credential
 * (`VAPI_WEBHOOK_SECRET`, constant-time compare), a 256 KB body cap, then the envelope.
 */
export async function readVapiWebhook(request: Request): Promise<VapiWebhook> {
  const secret = readSecret(process.env, "VAPI_WEBHOOK_SECRET");
  if (!secret) return reject(503, "webhook_not_configured");
  if (!bearerMatches(request.headers.get("authorization"), secret)) return reject(401, "unauthorized");

  const body = await readBodyLimited(request, MAX_VAPI_BODY_BYTES);
  if (!body) return reject(413, "body_too_large");

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return reject(400, "invalid_body");
  }
  const message = parseServerMessage(raw);
  if (!message) return reject(400, "invalid_message");
  return { ok: true, message, raw };
}
