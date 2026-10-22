import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { webhookEvents } from "@/db/schema";
import { readVar } from "@/server/config/env";
import { dbErrorCode } from "@/server/db-error";
import { configuredContext } from "@/server/payments/context";
import { processWebhookEvent } from "@/server/payments/webhook-processor";
import { getPayPalClient, labEnabled, PayPalNotConfiguredError } from "@/server/paypal";
import { eventResourceId, type PayPalEvent } from "@/server/paypal/webhook-events";
import {
  readBodyLimited,
  readWebhookHeaders,
  verifyWebhookOffline,
  verifyWebhookViaApi,
  type VerifyResult,
} from "@/server/paypal/webhooks";
import { MemoryRateLimiter } from "@/server/security/memory-rate-limit";

export const dynamic = "force-dynamic";

/** Caps authenticated PayPal calls that unauthenticated webhook requests can trigger (SPEC §11). */
const apiFallbackLimiter = new MemoryRateLimiter(30, 60_000);

const reject = (status: number, error: string) => Response.json({ ok: false, error }, { status });

/**
 * PayPal webhook receiver (SPEC §11): verify, store (deduplicated by event ID), then process — re-GET
 * the resource and drive the booking through the same CAS and ledger functions. 200 on success, 500 on
 * a handler error so PayPal retries (the reconciler re-drives it too). Unverified requests get a 4xx
 * and are never stored.
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
      resourceId: eventResourceId(event),
      summary: typeof event.summary === "string" ? event.summary.slice(0, 500) : null,
      raw: event,
      simulated: result.simulated,
      verifiedVia: result.via,
    })
    .onConflictDoNothing({ target: webhookEvents.paypalEventId })
    .returning({ id: webhookEvents.id });

  const duplicate = inserted.length === 0;
  const [row] = duplicate
    ? await getDb()
        .select({ id: webhookEvents.id, processedAt: webhookEvents.processedAt })
        .from(webhookEvents)
        .where(eq(webhookEvents.paypalEventId, event.id.slice(0, 100)))
    : inserted.map((r) => ({ id: r.id, processedAt: null }));
  if (!row || row.processedAt) return Response.json({ ok: true, duplicate });

  let ctx;
  try {
    ctx = configuredContext();
  } catch (error) {
    if (error instanceof PayPalNotConfiguredError) return Response.json({ ok: true, duplicate, processed: false });
    throw error;
  }
  try {
    await processWebhookEvent(ctx, row.id);
  } catch (error) {
    console.error(`[holdline] PayPal webhook ${event.event_type} processing failed: ${dbErrorCode(error)}`);
    return reject(500, "processing_failed");
  }
  return Response.json({ ok: true, duplicate });
}
