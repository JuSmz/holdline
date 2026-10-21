import { randomUUID } from "node:crypto";

import { labApiGuard } from "@/server/lab";
import { getPayPalClient } from "@/server/paypal";
import { PayPalApiError } from "@/server/paypal/errors";
import { createAuthorizeOrder } from "@/server/paypal/orders";

export const dynamic = "force-dynamic";

/** Fixed lab amount, set by the server — the browser never sends an amount (SPEC §9.1). */
const LAB_AMOUNT_CENTS = 2500;

export async function POST(request: Request) {
  const denied = await labApiGuard(request);
  if (denied) return denied;

  const client = getPayPalClient();
  const run = randomUUID().slice(0, 8);
  try {
    const order = await createAuthorizeOrder(client, {
      requestId: client.requestId("lab", "order-create", run),
      amountCents: LAB_AMOUNT_CENTS,
      currency: "USD",
      customId: `lab-${run}`,
      invoiceId: `${client.instanceId}-LAB-${run}`,
      description: "Holdline lab hold",
      brandName: "Holdline Lab",
    });
    return Response.json({ orderId: order.id });
  } catch (error) {
    if (error instanceof PayPalApiError) {
      return Response.json(
        { error: { status: error.status, issue: error.issue ?? error.errorName, debugId: error.debugId } },
        { status: 502 },
      );
    }
    throw error;
  }
}
