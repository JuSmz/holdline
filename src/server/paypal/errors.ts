/** A parsed PayPal REST error (HTTP status + `name`, first detail `issue`, `debug_id`). */
export class PayPalApiError extends Error {
  readonly status: number;
  readonly errorName: string | undefined;
  readonly issue: string | undefined;
  readonly debugId: string | undefined;
  readonly details: { issue?: string; description?: string; field?: string }[];
  /** "oauth" when the token request failed — the API request itself was never sent. */
  readonly phase: "api" | "oauth";

  constructor(init: {
    status: number;
    errorName?: string;
    message?: string;
    issue?: string;
    debugId?: string;
    details?: { issue?: string; description?: string; field?: string }[];
    phase?: "api" | "oauth";
  }) {
    super(
      `PayPal ${init.phase === "oauth" ? "OAuth" : "API"} ${init.status}` +
        `${init.issue ? ` ${init.issue}` : init.errorName ? ` ${init.errorName}` : ""}` +
        `${init.message ? `: ${init.message}` : ""}${init.debugId ? ` (debug_id ${init.debugId})` : ""}`,
    );
    this.name = "PayPalApiError";
    this.status = init.status;
    this.errorName = init.errorName;
    this.issue = init.issue;
    this.debugId = init.debugId;
    this.details = init.details ?? [];
    this.phase = init.phase ?? "api";
  }
}

/**
 * The request may have reached PayPal but we don't know the result: network failure, timeout,
 * or a body that couldn't be read after a 2xx. Outcome is UNKNOWN (SPEC §10.3) — never "failed".
 */
export class PayPalNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PayPalNetworkError";
  }
}

export async function parsePayPalError(response: Response, phase: "api" | "oauth" = "api"): Promise<PayPalApiError> {
  const debugHeader = response.headers.get("paypal-debug-id") ?? undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const b = (body ?? {}) as {
    name?: string;
    message?: string;
    debug_id?: string;
    details?: { issue?: string; description?: string; field?: string }[];
    error?: string;
    error_description?: string;
  };
  return new PayPalApiError({
    status: response.status,
    errorName: b.name ?? b.error,
    message: b.message ?? b.error_description,
    issue: b.details?.[0]?.issue,
    debugId: b.debug_id ?? debugHeader,
    details: b.details,
    phase,
  });
}

/** The PayPal operations whose "this already happened" errors we know how to reconcile. */
export type ReconcilableOp = "capture" | "void" | "authorize";

/**
 * What an "already happened" error means for a given operation (SPEC §10.1). The caller GETs the
 * resource to confirm, then reconciles toward the returned state. Returns null when the error is
 * not an "already done" signal for that operation.
 *
 * Note PREVIOUSLY_CAPTURED on VOID: the void did NOT happen — the money was captured. That must
 * reconcile to "captured", never to "voided".
 */
export function alreadyDoneOutcome(op: ReconcilableOp, error: unknown): "captured" | "voided" | "authorized" | null {
  if (!(error instanceof PayPalApiError) || !error.issue) return null;
  switch (op) {
    case "capture":
      return ["AUTHORIZATION_ALREADY_CAPTURED", "PREVIOUSLY_CAPTURED", "DUPLICATE_INVOICE_ID"].includes(error.issue)
        ? "captured"
        : null;
    case "void":
      if (error.issue === "PREVIOUSLY_VOIDED") return "voided";
      if (error.issue === "PREVIOUSLY_CAPTURED") return "captured";
      return null;
    case "authorize":
      return error.issue === "ORDER_ALREADY_AUTHORIZED" ? "authorized" : null;
  }
}

/**
 * DUPLICATE_INVOICE_ID on order create/authorize: ANOTHER transaction already used this invoice_id.
 * Not a success — look up what holds it before any new attempt (another order may hold money).
 */
export function isDuplicateInvoiceConflict(error: unknown): boolean {
  return error instanceof PayPalApiError && error.issue === "DUPLICATE_INVOICE_ID";
}

/** Payer-side declines: the booking stays pending and the payer may retry with a new order (SPEC §9.2). */
const DECLINED = new Set([
  "INSTRUMENT_DECLINED",
  "PAYMENT_DENIED",
  "INSUFFICIENT_FUNDS",
  "TRANSACTION_REFUSED",
  "PAYER_ACTION_REQUIRED",
  "PAYER_CANNOT_PAY",
  "MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED",
]);

export function isDeclined(error: unknown): boolean {
  return error instanceof PayPalApiError && error.issue !== undefined && DECLINED.has(error.issue);
}

/** 409 PREVIOUS_REQUEST_IN_PROGRESS: the same request is still running at PayPal — retry later with the same ID. */
export function isInProgress(error: unknown): boolean {
  return (
    error instanceof PayPalApiError &&
    error.status === 409 &&
    (error.issue === "PREVIOUS_REQUEST_IN_PROGRESS" || error.errorName === "RESOURCE_CONFLICT")
  );
}
