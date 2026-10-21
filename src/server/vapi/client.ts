import { readVar } from "@/server/config/env";

export const VAPI_API_BASE = "https://api.vapi.ai";
const TIMEOUT_MS = 10_000;

export class VapiNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`Vapi is not configured (${missing} missing)`);
    this.name = "VapiNotConfiguredError";
  }
}

/** A non-2xx answer from the Vapi API. `detail` is Vapi's own message, trimmed; it never contains our key. */
export class VapiApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Vapi API ${status}: ${detail}`);
    this.name = "VapiApiError";
  }
}

export type VapiClientOptions = { apiKey: string; fetch?: typeof globalThis.fetch; baseUrl?: string };

/**
 * Minimal Vapi REST client (private key, server side only). One attempt per call: a retried
 * POST /call/web could start a second call. No request body or key is ever logged.
 */
export class VapiClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(options: VapiClientOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? VAPI_API_BASE;
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  patch<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new VapiApiError(response.status, errorDetail(text));
    return (text ? JSON.parse(text) : null) as T;
  }
}

function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    const message = Array.isArray(parsed.message) ? parsed.message.join("; ") : parsed.message;
    return String(message ?? parsed.error ?? text).slice(0, 500);
  } catch {
    return text.slice(0, 200);
  }
}

export function getVapiClient(env: Record<string, string | undefined> = process.env): VapiClient {
  const apiKey = readVar(env, "VAPI_PRIVATE_KEY");
  if (!apiKey) throw new VapiNotConfiguredError("VAPI_PRIVATE_KEY");
  return new VapiClient({ apiKey });
}
