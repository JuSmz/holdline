import { centsToPayPal, type Currency } from "@/server/money";

import type { PayPalClient } from "./client";
import type { Authorization, Order } from "./types";

export type CreateAuthorizeOrderInput = {
  requestId: string;
  amountCents: number;
  currency: Currency;
  /** Our booking ID (never shown to the payer). */
  customId: string;
  /** Unique per merchant: `<instance>-<ref>-<attempt>` (SPEC §10.4). */
  invoiceId: string;
  /** Fixed label, never free text (SPEC §9.2). */
  description: string;
  brandName: string;
};

function orderIds(data: unknown): Record<string, string> {
  const order = data as Order | null;
  const ids: Record<string, string> = {};
  if (order?.id) ids.orderId = order.id;
  const authorization = order ? firstAuthorization(order) : undefined;
  if (authorization) {
    ids.authorizationId = authorization.id;
    ids.authorizationStatus = authorization.status;
  }
  return ids;
}

/** POST /v2/checkout/orders with intent AUTHORIZE. The amount always comes from our DB snapshot. */
export async function createAuthorizeOrder(client: PayPalClient, input: CreateAuthorizeOrderInput): Promise<Order> {
  const { data } = await client.post<Order>(
    "/v2/checkout/orders",
    {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          custom_id: input.customId,
          invoice_id: input.invoiceId,
          description: input.description,
          amount: { currency_code: input.currency, value: centsToPayPal(input.amountCents) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: input.brandName,
            shipping_preference: "NO_SHIPPING",
            user_action: "CONTINUE",
          },
        },
      },
    },
    { op: "orders.create", requestId: input.requestId, idsFrom: orderIds },
  );
  if (!data) throw new Error("PayPal returned no order");
  return data;
}

export async function getOrder(client: PayPalClient, orderId: string): Promise<Order> {
  return client.get<Order>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
    op: "orders.get",
    idsFrom: orderIds,
  });
}

/** POST /v2/checkout/orders/{id}/authorize. Check `firstAuthorization(order).status` before trusting it (SPEC §9.2). */
export async function authorizeOrder(
  client: PayPalClient,
  orderId: string,
  options: { requestId: string; mockResponse?: string },
): Promise<Order> {
  const { data } = await client.post<Order>(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
    {},
    { op: "orders.authorize", requestId: options.requestId, mockResponse: options.mockResponse, idsFrom: orderIds },
  );
  if (!data) throw new Error("PayPal returned no order");
  return data;
}

export function firstAuthorization(order: Order): Authorization | undefined {
  return order.purchase_units?.[0]?.payments?.authorizations?.[0];
}
