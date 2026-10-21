import { createHash } from "node:crypto";

import { centsToPayPal, type Currency } from "@/server/money";

import { isUnknownOutcome, type PayPalClient } from "./client";
import { PayPalApiError } from "./errors";

/** Payouts v1 (SPEC §9.9). Note: Payouts amounts use `{ value, currency }`, not `currency_code`. */

export type PayoutBatchStatus = "DENIED" | "PENDING" | "PROCESSING" | "SUCCESS" | "CANCELED";
export type PayoutItemStatus =
  "SUCCESS" | "FAILED" | "PENDING" | "UNCLAIMED" | "RETURNED" | "ONHOLD" | "BLOCKED" | "REFUNDED" | "REVERSED";

export type PayoutItem = {
  payout_item_id: string;
  transaction_id?: string;
  transaction_status?: PayoutItemStatus;
  payout_batch_id: string;
  payout_item: {
    recipient_type?: string;
    amount: { value: string; currency: string };
    receiver: string;
    sender_item_id?: string;
    note?: string;
  };
  errors?: { name?: string; message?: string };
  time_processed?: string;
};

export type PayoutBatch = {
  batch_header: {
    payout_batch_id: string;
    batch_status: PayoutBatchStatus;
    sender_batch_header: { sender_batch_id?: string };
    amount?: { value: string; currency: string };
    fees?: { value: string; currency: string };
    time_created?: string;
    time_completed?: string;
  };
  items?: PayoutItem[];
};

/** Sandbox-only payout test values (`items[0].note`), see PayPal's Payouts negative testing. */
const PAYOUT_TEST_CODE = /^(ERR|POS)PYO\d{3}$/;
const SENDER_BATCH_ID = /^[A-Za-z0-9_-]{1,127}$/;
const SENDER_ITEM_ID = /^[A-Za-z0-9_-]{1,63}$/;

/**
 * Deterministic payout IDs from the natural key (SPEC §9.9): the same money source, technician and
 * attempt always yield the same IDs, so a crash-retry can never create a second payout.
 * sender_batch_id ≤ 127 chars, sender_item_id ≤ 63 chars, both instance-prefixed (SPEC §10.4).
 */
export function payoutIds(key: {
  instanceId: string;
  source: "capture" | "invoice" | "lab" | "smoke";
  sourceId: string;
  technicianKey: string;
  attempt: number;
}): { senderBatchId: string; senderItemId: string } {
  if (!Number.isInteger(key.attempt) || key.attempt < 1) throw new Error("attempt must be a positive integer");
  const clean = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, "");
  const natural = `${key.source}-${clean(key.sourceId)}-${clean(key.technicianKey)}-${key.attempt}`;
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  let senderBatchId = `${key.instanceId}-${natural}`;
  if (senderBatchId.length > 127) senderBatchId = `${key.instanceId}-${key.source}-${hash(natural).slice(0, 48)}`;
  const senderItemId = `${key.instanceId}-${hash(senderBatchId).slice(0, 40)}`;
  return { senderBatchId, senderItemId };
}

export type CreatePayoutInput = {
  /** Deterministic natural key incl. instance prefix, e.g. `p1-capture-<captureId>-<techId>-1` (SPEC §9.9). */
  senderBatchId: string;
  senderItemId: string;
  receiverEmail: string;
  amountCents: number;
  currency: Currency;
  note?: string;
  emailSubject: string;
  emailMessage: string;
};

/**
 * POST /v1/payments/payouts with one item. PayPal rejects a sender_batch_id reused within 30 days;
 * that rejection is recovered via `duplicateBatchId()` so a crash-retry never pays twice.
 */
export async function createPayout(
  client: PayPalClient,
  input: CreatePayoutInput,
  options: {
    allowTestCodes?: boolean;
    /** Lab/smoke only: probe PayPal's duplicate sender_batch_id response with a fresh request ID. */
    requestIdOverride?: string;
  } = {},
): Promise<{ payoutBatchId: string; batchStatus: PayoutBatchStatus }> {
  if (!SENDER_BATCH_ID.test(input.senderBatchId)) throw new Error(`invalid sender_batch_id: ${input.senderBatchId}`);
  if (!input.senderBatchId.startsWith(`${client.instanceId}-`)) {
    throw new Error(`sender_batch_id must start with the instance prefix "${client.instanceId}-"`);
  }
  if (!SENDER_ITEM_ID.test(input.senderItemId) || !input.senderItemId.startsWith(`${client.instanceId}-`)) {
    throw new Error(`invalid sender_item_id (instance-prefixed, ≤ 63 chars): ${input.senderItemId}`);
  }
  if (input.note && PAYOUT_TEST_CODE.test(input.note.trim()) && !options.allowTestCodes) {
    throw new Error("payout negative-test codes are only allowed in the lab");
  }

  const { data } = await client.post<{ batch_header: PayoutBatch["batch_header"] }>(
    "/v1/payments/payouts",
    {
      sender_batch_header: {
        sender_batch_id: input.senderBatchId,
        recipient_type: "EMAIL",
        email_subject: input.emailSubject.slice(0, 255),
        email_message: input.emailMessage.slice(0, 1000),
      },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: input.receiverEmail,
          sender_item_id: input.senderItemId,
          recipient_wallet: "PAYPAL",
          amount: { value: centsToPayPal(input.amountCents), currency: input.currency },
          ...(input.note ? { note: input.note.slice(0, 4000) } : {}),
        },
      ],
    },
    {
      op: "payouts.create",
      requestId: options.requestIdOverride ?? client.requestId("payout", input.senderItemId),
      statusFrom: (d) => (d as { batch_header?: { batch_status?: string } }).batch_header?.batch_status ?? null,
      idsFrom: (d): Record<string, string> => {
        const header = (d as { batch_header?: PayoutBatch["batch_header"] }).batch_header;
        return header ? { payoutBatchId: header.payout_batch_id, senderBatchId: input.senderBatchId } : {};
      },
    },
  );
  if (!data?.batch_header) throw new Error("PayPal returned no payout batch");
  return { payoutBatchId: data.batch_header.payout_batch_id, batchStatus: data.batch_header.batch_status };
}

/** If PayPal rejected a duplicate sender_batch_id, return the original batch ID from the error's link. */
export function duplicateBatchId(error: unknown): string | null {
  if (!(error instanceof PayPalApiError) || (error.status !== 400 && error.status !== 422)) return null;
  // Observed in the sandbox (report row 17): 400 USER_BUSINESS_ERROR, details[].field = SENDER_BATCH_ID,
  // the original batch in details[].link.
  const aboutBatchId = error.details.some(
    (d) => d.field === "SENDER_BATCH_ID" || /sender_batch_id/i.test(d.issue ?? ""),
  );
  if (!aboutBatchId) return null;
  for (const link of error.links) {
    const match = /\/v1\/payments\/payouts\/([A-Z0-9]+)(?:[/?#]|$)/.exec(link.href);
    if (match) return match[1];
  }
  return null;
}

export async function getPayoutBatch(client: PayPalClient, payoutBatchId: string): Promise<PayoutBatch> {
  return client.get<PayoutBatch>(`/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`, {
    op: "payouts.batch.get",
    statusFrom: (d) => (d as PayoutBatch).batch_header?.batch_status ?? null,
    idsFrom: (d) => ({ payoutBatchId: (d as PayoutBatch).batch_header?.payout_batch_id ?? payoutBatchId }),
  });
}

export async function getPayoutItem(client: PayPalClient, payoutItemId: string): Promise<PayoutItem> {
  return client.get<PayoutItem>(`/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}`, {
    op: "payouts.item.get",
    statusFrom: (d) => (d as PayoutItem).transaction_status ?? null,
    idsFrom: () => ({ payoutItemId }),
  });
}

/** Only UNCLAIMED items can be cancelled; do this before any retry (SPEC §9.9). */
export async function cancelUnclaimedItem(
  client: PayPalClient,
  payoutItemId: string,
  options: { requestId: string },
): Promise<PayoutItem> {
  try {
    const { data } = await client.post<PayoutItem>(
      `/v1/payments/payouts-item/${encodeURIComponent(payoutItemId)}/cancel`,
      undefined,
      {
        op: "payouts.item.cancel",
        requestId: options.requestId,
        statusFrom: (d) => (d as PayoutItem).transaction_status ?? null,
        idsFrom: () => ({ payoutItemId }),
      },
    );
    if (!data) throw new Error("PayPal returned no payout item");
    return data;
  } catch (error) {
    // A retried cancel of an item that is already cancelled: read the real status instead of failing.
    if (error instanceof PayPalApiError && error.errorName === "ITEM_ALREADY_CANCELLED") {
      return getPayoutItem(client, payoutItemId);
    }
    throw error;
  }
}

/** Item statuses that are final for our retry logic (SPEC §9.9). */
export function payoutItemOutcome(
  status: PayoutItemStatus | undefined,
): "succeeded" | "retryable" | "wait" | "cancel_first" | "needs_review" {
  switch (status) {
    case "SUCCESS":
      return "succeeded";
    case "FAILED":
    case "RETURNED":
    case "BLOCKED":
      return "retryable";
    case "UNCLAIMED":
      return "cancel_first";
    case "REFUNDED":
    case "REVERSED":
      return "needs_review"; // delivered, then given back — never auto-retry; alert the owner
    default:
      return "wait"; // PENDING, ONHOLD, undefined
  }
}

/**
 * Payout API errors carry their reason in `name` (e.g. INSUFFICIENT_FUNDS), not `details[].issue`
 * (sandbox report row 12). A NEW attempt (new sender_batch_id) is only ever created after a GET shows the
 * item FAILED/RETURNED/BLOCKED — never from an HTTP error alone (SPEC §9.9).
 */
export function payoutErrorOutcome(error: unknown): "unknown" | "recover_duplicate" | "definite" {
  if (isUnknownOutcome(error)) return "unknown";
  if (duplicateBatchId(error)) return "recover_duplicate";
  return "definite";
}
