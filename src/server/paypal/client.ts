import { PayPalApiError, PayPalNetworkError, isInProgress, parsePayPalError } from "./errors";

/** Holdline only ever talks to the sandbox (SPEC §5). There is deliberately no live URL here. */
export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
export const MAX_ATTEMPTS = 3;
export const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9:_.-]{1,108}$/;

export type ApiLogEntry = {
  op: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  httpStatus: number | null;
  requestId: string | null;
  resourceIds: Record<string, string>;
  resourceStatus: string | null;
  debugId: string | null;
  issue: string | null;
  attempts: number;
  durationMs: number;
};

export type PayPalClientOptions = {
  clientId: string;
  clientSecret: string;
  /** Prefix for every PayPal-facing ID (SPEC §10.4), e.g. "p1", "dj", "t-unit". */
  instanceId: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  log?: (entry: ApiLogEntry) => void;
  /** `PayPal-Mock-Response` negative testing — only in tests and when LAB_ENABLED=true. */
  allowMockResponses?: boolean;
};

export type CallOptions = {
  /** Short operation name for logs, e.g. "orders.authorize". */
  op: string;
  /** Sandbox negative testing, e.g. `{"mock_application_codes":"INSTRUMENT_DECLINED"}`. */
  mockResponse?: string;
  /** Pulls resource IDs out of a successful response body for the API log. */
  idsFrom?: (data: unknown) => Record<string, string>;
};

export type PostOptions = CallOptions & {
  /** Required on every POST (SPEC §10.1). Build it with `client.requestId(...)`. */
  requestId: string;
  prefer?: "return=representation" | "return=minimal";
};

/** A JSON body that must be sent byte-for-byte (e.g. the webhook event in verify-webhook-signature). */
export class RawJson {
  constructor(readonly text: string) {}
}

type Token = { value: string; expiresAt: number };

const isRetryableApiError = (error: PayPalApiError) => error.status >= 500 || isInProgress(error);

/**
 * Thin PayPal REST client.
 * - OAuth token cached and refreshed early; a 401 refreshes once; OAuth 5xx/network errors are retried.
 * - Every POST carries a `PayPal-Request-Id` (enforced by type and at runtime).
 * - Network errors, 5xx, 409 PREVIOUS_REQUEST_IN_PROGRESS and unreadable 2xx bodies are retried with
 *   the SAME request ID (PayPal replays the stored result). If they persist, the outcome is UNKNOWN.
 * - Every call is logged without secrets or PII.
 */
export class PayPalClient {
  readonly instanceId: string;
  private readonly opts: Required<Omit<PayPalClientOptions, "log">> & { log?: PayPalClientOptions["log"] };
  private token: Token | undefined;
  private tokenInFlight: Promise<Token> | undefined;

  constructor(options: PayPalClientOptions) {
    if (!options.clientId || !options.clientSecret) throw new Error("PayPal client ID and secret are required");
    if (!/^[a-z0-9-]{1,8}$/.test(options.instanceId)) throw new Error("invalid instanceId");
    this.instanceId = options.instanceId;
    this.opts = {
      fetch: globalThis.fetch.bind(globalThis),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      random: Math.random,
      allowMockResponses: false,
      ...options,
    };
  }

  /** Deterministic, instance-prefixed request ID, e.g. `p1:order-authorize:<orderId>`. */
  requestId(...parts: string[]): string {
    const id = [this.instanceId, ...parts].join(":");
    if (!REQUEST_ID_PATTERN.test(id)) throw new Error(`invalid PayPal-Request-Id: ${id}`);
    return id;
  }

  async get<T>(path: string, options: CallOptions): Promise<T> {
    const { data } = await this.call<T>("GET", path, undefined, options);
    return data as T;
  }

  async post<T>(path: string, body: unknown, options: PostOptions): Promise<{ status: number; data: T | null }> {
    if (!options.requestId || !REQUEST_ID_PATTERN.test(options.requestId)) {
      throw new Error(`POST ${path} requires a valid PayPal-Request-Id`);
    }
    if (!options.requestId.startsWith(`${this.instanceId}:`)) {
      throw new Error(`PayPal-Request-Id must start with the instance prefix "${this.instanceId}:"`);
    }
    return this.call<T>("POST", path, body, options);
  }

  async patch(path: string, body: unknown, options: CallOptions): Promise<void> {
    await this.call("PATCH", path, body, options);
  }

  private async call<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    options: CallOptions & { requestId?: string; prefer?: string },
  ): Promise<{ status: number; data: T | null }> {
    if (options.mockResponse && !this.opts.allowMockResponses) {
      throw new Error("PayPal-Mock-Response is only allowed in tests and the lab");
    }
    const started = this.opts.now();
    const payload = body === undefined ? undefined : body instanceof RawJson ? body.text : JSON.stringify(body);
    let attempts = 0;
    let refreshedToken = false;
    let lastError: unknown;
    let lastStatus: number | null = null;

    while (attempts < MAX_ATTEMPTS) {
      attempts += 1;

      // 1) Token. A failure here means the API request was never sent (phase "oauth").
      let token: Token;
      try {
        token = await this.getToken();
      } catch (error) {
        lastError =
          error instanceof PayPalApiError
            ? error
            : new PayPalApiError({ status: 0, errorName: "OAUTH_NETWORK_ERROR", phase: "oauth" });
        const retryable = !(error instanceof PayPalApiError) || error.status >= 500;
        if (retryable && attempts < MAX_ATTEMPTS) {
          await this.backoff(attempts);
          continue;
        }
        break;
      }

      // 2) The request. Network errors and timeouts: outcome unknown, retry with the same request ID.
      let response: Response;
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token.value}`,
          Accept: "application/json",
        };
        if (payload !== undefined) headers["Content-Type"] = "application/json";
        if (options.requestId) headers["PayPal-Request-Id"] = options.requestId;
        if (method === "POST") headers.Prefer = options.prefer ?? "return=representation";
        if (options.mockResponse) headers["PayPal-Mock-Response"] = options.mockResponse;

        response = await this.opts.fetch(`${PAYPAL_SANDBOX_BASE_URL}${path}`, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: "error",
        });
      } catch (error) {
        lastError = new PayPalNetworkError(`${method} ${path} failed: ${(error as Error).message}`, { cause: error });
        lastStatus = null;
        if (attempts < MAX_ATTEMPTS) await this.backoff(attempts);
        continue;
      }

      if (response.status === 401 && !refreshedToken) {
        refreshedToken = true;
        this.token = undefined;
        attempts -= 1; // a token refresh doesn't count as an attempt
        continue;
      }

      // 3) Success: read the body inside the guard. A body that can't be read after a 2xx means
      //    PayPal DID act but we lost the result — retry with the same request ID to get it replayed.
      if (response.ok) {
        let data: T | null;
        try {
          const text = response.status === 204 ? "" : await response.text();
          data = text ? (JSON.parse(text) as T) : null;
        } catch (error) {
          lastError = new PayPalNetworkError(`${method} ${path}: unreadable ${response.status} body`, { cause: error });
          lastStatus = response.status;
          if (attempts < MAX_ATTEMPTS) await this.backoff(attempts);
          continue;
        }
        this.log({
          op: options.op,
          method,
          path,
          httpStatus: response.status,
          requestId: options.requestId ?? null,
          resourceIds: safeIds(options.idsFrom, data),
          resourceStatus: statusOf(data),
          debugId: response.headers.get("paypal-debug-id"),
          issue: null,
          attempts,
          durationMs: this.opts.now() - started,
        });
        return { status: response.status, data };
      }

      const error = await parsePayPalError(response);
      lastError = error;
      lastStatus = error.status;
      if (isRetryableApiError(error) && attempts < MAX_ATTEMPTS) {
        await this.backoff(attempts);
        continue;
      }
      break;
    }

    const error = lastError as Error;
    const api = error instanceof PayPalApiError ? error : undefined;
    this.log({
      op: options.op,
      method,
      path: api?.phase === "oauth" ? "/v1/oauth2/token" : path,
      httpStatus: api ? api.status || null : lastStatus,
      requestId: options.requestId ?? null,
      resourceIds: {},
      resourceStatus: null,
      debugId: api?.debugId ?? null,
      issue: api ? (api.issue ?? api.errorName ?? null) : lastStatus !== null ? "BODY_READ_FAILED" : "NETWORK_ERROR",
      attempts,
      durationMs: this.opts.now() - started,
    });
    throw error;
  }

  private async backoff(attempt: number): Promise<void> {
    const base = 500 * 2 ** (attempt - 1);
    await this.opts.sleep(base + Math.floor(this.opts.random() * 250));
  }

  private async getToken(): Promise<Token> {
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.opts.now()) return this.token;
    this.tokenInFlight ??= this.fetchToken().finally(() => {
      this.tokenInFlight = undefined;
    });
    this.token = await this.tokenInFlight;
    return this.token;
  }

  private async fetchToken(): Promise<Token> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const response = await this.opts.fetch(`${PAYPAL_SANDBOX_BASE_URL}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) throw await parsePayPalError(response, "oauth");
    const data = (await response.json()) as { access_token: string; expires_in: number };
    return { value: data.access_token, expiresAt: this.opts.now() + data.expires_in * 1000 };
  }

  private log(entry: ApiLogEntry) {
    try {
      this.opts.log?.(entry);
    } catch {
      // logging must never break a payment call
    }
  }
}

/**
 * True when PayPal may or may not have performed the operation (SPEC §10.3): never mark such a
 * call "failed". OAuth failures are definite: the API request was never sent.
 */
export function isUnknownOutcome(error: unknown): boolean {
  if (error instanceof PayPalNetworkError) return true;
  return error instanceof PayPalApiError && error.phase === "api" && (error.status >= 500 || isInProgress(error));
}

function statusOf(data: unknown): string | null {
  const status = (data as { status?: unknown } | null)?.status;
  return typeof status === "string" ? status : null;
}

function safeIds(extract: CallOptions["idsFrom"], data: unknown): Record<string, string> {
  try {
    if (extract) return extract(data);
    const id = (data as { id?: unknown } | null)?.id;
    return typeof id === "string" ? { id } : {};
  } catch {
    return {};
  }
}
