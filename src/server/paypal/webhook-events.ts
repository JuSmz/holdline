/** The webhook events Holdline subscribes to (SPEC §11). Registered by scripts/paypal-webhook-setup.ts. */
export const SUBSCRIBED_EVENTS = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.AUTHORIZATION.CREATED",
  "PAYMENT.AUTHORIZATION.VOIDED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.CANCELLED",
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTSBATCH.PROCESSING",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.CANCELED",
  "PAYMENT.PAYOUTS-ITEM.HELD",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
  "PAYMENT.PAYOUTS-ITEM.REFUNDED",
] as const;

/** The parts of a PayPal webhook event body Holdline reads before re-GETting the resource. */
export type PayPalEvent = {
  id?: unknown;
  event_type?: unknown;
  resource_type?: unknown;
  summary?: unknown;
  resource?: {
    id?: unknown;
    invoice?: { id?: unknown };
    payout_item_id?: unknown;
    batch_header?: { payout_batch_id?: unknown };
  };
};

/** The resource ID differs per event family (orders/payments, invoicing, payout item, payout batch). */
export function eventResourceId(event: PayPalEvent): string | null {
  const r = event.resource;
  const candidates = [r?.id, r?.invoice?.id, r?.payout_item_id, r?.batch_header?.payout_batch_id];
  const id = candidates.find((c): c is string => typeof c === "string" && c.length > 0);
  return id ? id.slice(0, 100) : null;
}
