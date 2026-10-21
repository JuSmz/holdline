import { centsToPayPal, type Currency } from "@/server/money";

import type { PayPalClient } from "./client";
import type { Authorization, Capture } from "./types";

const path = (authorizationId: string, action = "") =>
  `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}${action ? `/${action}` : ""}`;

export async function getAuthorization(client: PayPalClient, authorizationId: string): Promise<Authorization> {
  return client.get<Authorization>(path(authorizationId), {
    op: "payments.authorization.get",
    idsFrom: (d) => ({ authorizationId: (d as Authorization).id }),
  });
}

export type CaptureInput = {
  requestId: string;
  /** Omit to capture the full authorized amount. Holdline always sends it explicitly (SPEC §9.3). */
  amountCents?: number;
  currency: Currency;
  finalCapture: boolean;
  invoiceId?: string;
  noteToPayer?: string;
  mockResponse?: string;
};

/** POST /v2/payments/authorizations/{id}/capture. `final_capture: true` means no further captures. */
export async function captureAuthorization(
  client: PayPalClient,
  authorizationId: string,
  input: CaptureInput,
): Promise<Capture> {
  const body: Record<string, unknown> = { final_capture: input.finalCapture };
  if (input.amountCents !== undefined) {
    body.amount = { currency_code: input.currency, value: centsToPayPal(input.amountCents) };
  }
  if (input.invoiceId) body.invoice_id = input.invoiceId;
  if (input.noteToPayer) body.note_to_payer = input.noteToPayer.slice(0, 255);

  const { data } = await client.post<Capture>(path(authorizationId, "capture"), body, {
    op: "payments.capture",
    requestId: input.requestId,
    mockResponse: input.mockResponse,
    idsFrom: (d) => ({ authorizationId, captureId: (d as Capture).id }),
  });
  if (!data) throw new Error("PayPal returned no capture");
  return data;
}

/**
 * POST /v2/payments/authorizations/{id}/void. Always void the PARENT authorization:
 * a reauthorization cannot be voided (CANNOT_BE_VOIDED, SPEC §9.5).
 */
export async function voidAuthorization(
  client: PayPalClient,
  authorizationId: string,
  options: { requestId: string; mockResponse?: string },
): Promise<Authorization | null> {
  const { data } = await client.post<Authorization>(path(authorizationId, "void"), undefined, {
    op: "payments.void",
    requestId: options.requestId,
    mockResponse: options.mockResponse,
    idsFrom: () => ({ authorizationId }),
  });
  return data;
}

/**
 * POST /v2/payments/authorizations/{id}/reauthorize. Allowed after the 3-day honor period,
 * once per chain (SPEC §12). Returns the NEW authorization, which becomes active for capture.
 */
export async function reauthorizeAuthorization(
  client: PayPalClient,
  authorizationId: string,
  input: { requestId: string; amountCents?: number; currency: Currency },
): Promise<Authorization> {
  const body =
    input.amountCents === undefined
      ? {}
      : { amount: { currency_code: input.currency, value: centsToPayPal(input.amountCents) } };
  const { data } = await client.post<Authorization>(path(authorizationId, "reauthorize"), body, {
    op: "payments.reauthorize",
    requestId: input.requestId,
    idsFrom: (d) => ({ parentAuthorizationId: authorizationId, authorizationId: (d as Authorization).id }),
  });
  if (!data) throw new Error("PayPal returned no authorization");
  return data;
}

export async function getCapture(client: PayPalClient, captureId: string): Promise<Capture> {
  return client.get<Capture>(`/v2/payments/captures/${encodeURIComponent(captureId)}`, {
    op: "payments.capture.get",
    idsFrom: () => ({ captureId }),
  });
}
