import { z } from "zod";

import { readVar } from "@/server/config/env";
import { labApiGuard } from "@/server/lab";
import { getPayPalClient } from "@/server/paypal";
import { PayPalApiError } from "@/server/paypal/errors";
import { authorizeOrder, firstAuthorization } from "@/server/paypal/orders";

export const dynamic = "force-dynamic";

const PAYPAL_ID = /^[A-Z0-9-]{5,40}$/;
const input = z.object({ orderId: z.string().regex(PAYPAL_ID), simulateDecline: z.boolean().default(false) });

function payeeMatches(email: string | undefined): boolean | null {
  const business = readVar(process.env, "PAYPAL_BUSINESS_EMAIL");
  if (!business || !email) return null;
  return business.toLowerCase() === email.toLowerCase();
}

export async function POST(request: Request) {
  const denied = await labApiGuard(request);
  if (denied) return denied;

  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: { issue: "INVALID_INPUT" } }, { status: 400 });
  const { orderId, simulateDecline } = parsed.data;

  const client = getPayPalClient();
  try {
    const order = await authorizeOrder(client, orderId, {
      requestId: client.requestId("lab", "order-authorize", orderId),
      mockResponse: simulateDecline ? JSON.stringify({ mock_application_codes: "INSTRUMENT_DECLINED" }) : undefined,
    });
    const authorization = firstAuthorization(order);
    return Response.json({
      orderStatus: order.status,
      authorization: authorization
        ? {
            id: authorization.id,
            status: authorization.status,
            statusReason: authorization.status_details?.reason ?? null,
            amount: authorization.amount,
            expirationTime: authorization.expiration_time ?? null,
            createTime: authorization.create_time ?? null,
          }
        : null,
      payee: order.purchase_units?.[0]?.payee ?? null,
      // R10: the payee must be our US sandbox business account (country itself is checked in the dashboard).
      payeeMatchesBusiness: payeeMatches(order.purchase_units?.[0]?.payee?.email_address),
      buyerCountry: order.payer?.address?.country_code ?? null,
    });
  } catch (error) {
    if (error instanceof PayPalApiError) {
      return Response.json(
        { error: { status: error.status, issue: error.issue ?? error.errorName, debugId: error.debugId } },
        { status: 200 },
      );
    }
    throw error;
  }
}
