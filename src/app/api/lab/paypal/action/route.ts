import { randomUUID } from "node:crypto";

import { z } from "zod";

import { labApiGuard } from "@/server/lab";
import { getPayPalClient } from "@/server/paypal";
import { PayPalApiError } from "@/server/paypal/errors";
import {
  captureAuthorization,
  getAuthorization,
  reauthorizeAuthorization,
  voidAuthorization,
} from "@/server/paypal/payments";

export const dynamic = "force-dynamic";

const PAYPAL_ID = /^[A-Z0-9-]{5,40}$/;
const input = z.object({
  action: z.enum(["get", "capture_full", "capture_partial_final", "void", "reauthorize"]),
  authorizationId: z.string().regex(PAYPAL_ID),
});

/** Lab amounts are fixed on the server (SPEC §9.1). */
const LAB_FULL_CENTS = 2500;
const LAB_PARTIAL_CENTS = 1000;

export async function POST(request: Request) {
  const denied = await labApiGuard(request);
  if (denied) return denied;

  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: { issue: "INVALID_INPUT" } }, { status: 400 });
  const { action, authorizationId } = parsed.data;

  const client = getPayPalClient();
  const run = randomUUID().slice(0, 8);
  try {
    switch (action) {
      case "get":
        return Response.json({ authorization: await getAuthorization(client, authorizationId) });
      case "capture_full":
        return Response.json({
          capture: await captureAuthorization(client, authorizationId, {
            requestId: client.requestId("lab", "capture-full", authorizationId, run),
            amountCents: LAB_FULL_CENTS,
            currency: "USD",
            finalCapture: true,
          }),
          authorizationAfter: await getAuthorization(client, authorizationId),
        });
      case "capture_partial_final": {
        const capture = await captureAuthorization(client, authorizationId, {
          requestId: client.requestId("lab", "capture-partial", authorizationId, run),
          amountCents: LAB_PARTIAL_CENTS,
          currency: "USD",
          finalCapture: true,
        });
        // R2: does final_capture release the remainder? Look at the authorization afterwards.
        return Response.json({ capture, authorizationAfter: await getAuthorization(client, authorizationId) });
      }
      case "void":
        await voidAuthorization(client, authorizationId, {
          requestId: client.requestId("lab", "void", authorizationId, run),
        });
        return Response.json({ authorizationAfter: await getAuthorization(client, authorizationId) });
      case "reauthorize":
        return Response.json({
          reauthorization: await reauthorizeAuthorization(client, authorizationId, {
            requestId: client.requestId("lab", "reauth", authorizationId, run),
            currency: "USD",
          }),
        });
    }
  } catch (error) {
    if (error instanceof PayPalApiError) {
      return Response.json({
        error: { status: error.status, issue: error.issue ?? error.errorName, debugId: error.debugId },
      });
    }
    throw error;
  }
}
