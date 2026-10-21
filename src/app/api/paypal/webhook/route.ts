import { getDb } from "@/db/client";
import { webhookEvents } from "@/db/schema";
import { readVar } from "@/server/config/env";
import { getPayPalClient, labEnabled } from "@/server/paypal";
import {
  readBodyLimited,
  readWebhookHeaders,
  verifyWebhookOffline,
  verifyWebhookViaApi,
  type VerifyResult,
} from "@/server/paypal/webhooks";
import { MemoryRateLimiter } from "@/server/security/memory-rate-limit";

export const dynamic = "force-dynamic";

type PayPalEvent = {
  id?: unknown;
  event_type?: unknown;
  resource_type?: unknown;
  summary?: unknown;
  resource?: { id?: unknown };
};

/** Caps authenticated PayPal calls that unauthenticated webhook requests can trigger (SPEC §11). */
const apiFallbackLimiter = new MemoryRateLimiter(30, 60_000);

const reject = (status: number, error: string) => Response.json({ ok: false, error }, { status });

/**
 * PayPal webhook receiver (SPEC §11). Stage 2: verify and store. Processing (re-GET the
 * resource, drive the booking state machine) arrives in stage 6; `processed_at` stays null until then.
 * Unverified requests get a 4xx and are never stored.
 */
export async function POST(request: Request) {
  const webhookId = readVar(process.env, "PAYPAL_WEBHOOK_ID");
  if (!webhookId) return reject(503, "webhook_not_configured");

  const body = await readBodyLimited(request);
  if (!body) return reject(413, "body_too_large");

  const headers = readWebhookHeaders(request.headers);
  if (!headers) return reject(400, "missing_signature_headers");

  let event: PayPalEvent;
  try {
    event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as PayPalEvent;
  } catch {
    return reject(400, "invalid_body");
  }

  let result: VerifyResult = await verifyWebhookOffline({ headers, body, webhookId, acceptSimulator: labEnabled() });
  if (!result.ok && result.retryViaApi) {
    // Only for a transient failure fetching an allowed cert. Rate-limited; 503 lets PayPal retry later.
    if (!apiFallbackLimiter.take("verify-api")) return reject(503, "verification_busy");
    try {
      result = await verifyWebhookViaApi(getPayPalClient(), { headers, webhookId, rawBody: body });
    } catch {
      return reject(503, "verification_unavailable");
    }
  }
  if (!result.ok) {
    console.warn(`[holdline] rejected PayPal webhook: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
    return reject(400, "invalid_signature");
  }

  if (typeof event.id !== "string" || typeof event.event_type !== "string") return reject(400, "invalid_event");

  const inserted = await getDb()
    .insert(webhookEvents)
    .values({
      paypalEventId: event.id.slice(0, 100),
      eventType: event.event_type.slice(0, 100),
      resourceType: typeof event.resource_type === "string" ? event.resource_type.slice(0, 100) : null,
      resourceId: typeof event.resource?.id === "string" ? event.resource.id.slice(0, 100) : null,
      summary: typeof event.summary === "string" ? event.summary.slice(0, 500) : null,
      raw: event,
      simulated: result.simulated,
      verifiedVia: result.via,
    })
    .onConflictDoNothing({ target: webhookEvents.paypalEventId })
    .returning({ id: webhookEvents.id });

  return Response.json({ ok: true, duplicate: inserted.length === 0 });
}
