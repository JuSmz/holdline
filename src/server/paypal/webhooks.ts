import { X509Certificate, verify as cryptoVerify } from "node:crypto";
import { crc32 } from "node:zlib";

import { RawJson, type PayPalClient } from "./client";

/**
 * PayPal webhook signature verification (SPEC §11).
 *
 * Offline (PayPal's preferred method): verify RSA-SHA256 over
 *   `<transmission_id>|<transmission_time>|<webhook_id>|<crc32(raw body bytes), unsigned decimal>`
 * with the certificate from `paypal-cert-url`, which must live on PayPal's sandbox API host.
 * The `paypal-auth-algo` header is ignored: the algorithm is pinned.
 *
 * The API postback (`verify-webhook-signature`) is used ONLY when fetching an allowed cert fails
 * for a transient reason (network, timeout, 5xx), and the route rate-limits it.
 */

export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
/** PayPal's sandbox API hosts. Real events are recorded in docs/sandbox-report.md (row 9). */
export const ALLOWED_CERT_HOSTS = new Set(["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"]);
const CERT_PATH = /^\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]{1,100}$/;
const CERT_FETCH_TIMEOUT_MS = 3_000;
const MAX_CERT_BYTES = 16 * 1024;
const MAX_CACHED_CERTS = 8;
const NEGATIVE_CACHE_MS = 5 * 60_000;
/** PayPal's webhook simulator signs with this literal instead of a real webhook ID. */
export const SIMULATOR_WEBHOOK_ID = "WEBHOOK_ID";

export type WebhookHeaders = {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
};

export type VerifyResult =
  | { ok: true; via: "offline" | "api"; simulated: boolean }
  | { ok: false; reason: string; retryViaApi?: boolean; detail?: string };

export function readWebhookHeaders(headers: Headers): WebhookHeaders | null {
  const get = (name: string) => headers.get(name)?.trim() || undefined;
  const transmissionId = get("paypal-transmission-id");
  const transmissionTime = get("paypal-transmission-time");
  const transmissionSig = get("paypal-transmission-sig");
  const certUrl = get("paypal-cert-url");
  const authAlgo = get("paypal-auth-algo");
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) return null;
  if (transmissionId.length > 100 || transmissionTime.length > 50 || transmissionSig.length > 1024) return null;
  return { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo };
}

/** Returns the normalized cert URL (origin + path) if allowed, else null. */
export function normalizeCertUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const ok =
    url.protocol === "https:" &&
    ALLOWED_CERT_HOSTS.has(url.hostname) &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    CERT_PATH.test(url.pathname);
  return ok ? `${url.origin}${url.pathname}` : null;
}

export function isAllowedCertUrl(raw: string): boolean {
  return normalizeCertUrl(raw) !== null;
}

/** Hostname only, for logs (row 9 of the sandbox report). Never the full attacker-supplied URL. */
export function certHostForLog(raw: string): string {
  try {
    return new URL(raw).hostname.slice(0, 100);
  } catch {
    return "invalid-url";
  }
}

export function signedMessage(h: WebhookHeaders, webhookId: string, body: Uint8Array): string {
  return `${h.transmissionId}|${h.transmissionTime}|${webhookId}|${crc32(body) >>> 0}`;
}

/** Thrown by cert fetchers; `transient` failures (network/timeout/5xx) may fall back to the API. */
export class CertFetchError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "CertFetchError";
  }
}

export type CertFetcher = (url: string) => Promise<string>;

/** Fetches a PEM cert with no redirects, a short timeout and a streaming size cap. */
export const fetchCertPem: CertFetcher = async (url) => {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new CertFetchError(`cert fetch failed: ${(error as Error).message}`, true);
  }
  if (!response.ok) throw new CertFetchError(`cert fetch failed: HTTP ${response.status}`, response.status >= 500);
  const body = await readStreamLimited(response.body, MAX_CERT_BYTES);
  if (!body) throw new CertFetchError("cert too large", false);
  return new TextDecoder().decode(body);
};

/** Indirection so tests can swap the fetcher without network access. */
export const webhookDeps: { fetchCert: CertFetcher; now: () => Date } = {
  fetchCert: fetchCertPem,
  now: () => new Date(),
};

const certCache = new Map<string, X509Certificate>();
const failedCerts = new Map<string, { until: number; transient: boolean }>();

export function clearCertCache() {
  certCache.clear();
  failedCerts.clear();
}

async function loadCert(url: string): Promise<X509Certificate> {
  const cached = certCache.get(url);
  if (cached) return cached;
  const failed = failedCerts.get(url);
  if (failed && failed.until > webhookDeps.now().getTime()) {
    throw new CertFetchError("cert recently failed", failed.transient);
  }
  try {
    const cert = new X509Certificate(await webhookDeps.fetchCert(url));
    if (certCache.size >= MAX_CACHED_CERTS) certCache.delete(certCache.keys().next().value as string);
    certCache.set(url, cert);
    return cert;
  } catch (error) {
    const transient = error instanceof CertFetchError ? error.transient : false; // PEM parse errors are permanent
    if (failedCerts.size >= 100) failedCerts.clear();
    failedCerts.set(url, { until: webhookDeps.now().getTime() + NEGATIVE_CACHE_MS, transient });
    throw new CertFetchError((error as Error).message, transient);
  }
}

export async function verifyWebhookOffline(input: {
  headers: WebhookHeaders;
  body: Uint8Array;
  webhookId: string;
  acceptSimulator: boolean;
}): Promise<VerifyResult> {
  const { headers, body, webhookId } = input;
  const certUrl = normalizeCertUrl(headers.certUrl);
  if (!certUrl) return { ok: false, reason: "cert_url_not_allowed", detail: certHostForLog(headers.certUrl) };

  let cert: X509Certificate;
  try {
    cert = await loadCert(certUrl);
  } catch (error) {
    const transient = error instanceof CertFetchError && error.transient;
    return { ok: false, reason: "cert_fetch_failed", retryViaApi: transient };
  }

  const now = webhookDeps.now();
  if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) return { ok: false, reason: "cert_expired" };

  const signature = Buffer.from(headers.transmissionSig, "base64");
  const check = (id: string) =>
    cryptoVerify("sha256", Buffer.from(signedMessage(headers, id, body), "utf8"), cert.publicKey, signature);

  if (check(webhookId)) return { ok: true, via: "offline", simulated: false };
  if (input.acceptSimulator && check(SIMULATOR_WEBHOOK_ID)) return { ok: true, via: "offline", simulated: true };
  return { ok: false, reason: "signature_mismatch" };
}

/**
 * Fallback when an allowed cert can't be fetched (transient): ask PayPal to verify.
 * The event must be sent byte-for-byte as received — re-serialized JSON can fail verification.
 */
export async function verifyWebhookViaApi(
  client: PayPalClient,
  input: { headers: WebhookHeaders; webhookId: string; rawBody: Uint8Array },
): Promise<VerifyResult> {
  const h = input.headers;
  const rawEvent = new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody);
  const json =
    `{"auth_algo":${JSON.stringify(h.authAlgo)},"cert_url":${JSON.stringify(h.certUrl)},` +
    `"transmission_id":${JSON.stringify(h.transmissionId)},"transmission_sig":${JSON.stringify(h.transmissionSig)},` +
    `"transmission_time":${JSON.stringify(h.transmissionTime)},"webhook_id":${JSON.stringify(input.webhookId)},` +
    `"webhook_event":${rawEvent}}`;
  const { data } = await client.post<{ verification_status: string }>(
    "/v1/notifications/verify-webhook-signature",
    new RawJson(json),
    {
      op: "webhooks.verify",
      requestId: client.requestId("verify", h.transmissionId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64)),
    },
  );
  return data?.verification_status === "SUCCESS"
    ? { ok: true, via: "api", simulated: false }
    : { ok: false, reason: "api_verification_failed" };
}

async function readStreamLimited(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Reads a request body as bytes, refusing anything larger than `max`. */
export async function readBodyLimited(request: Request, max = MAX_WEBHOOK_BODY_BYTES): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  return readStreamLimited(request.body, max);
}
