import { randomUUID } from "node:crypto";

import { z } from "zod";

import { readVar } from "@/server/config/env";
import { labApiGuard } from "@/server/lab";
import { getPayPalClient } from "@/server/paypal";
import { PayPalApiError } from "@/server/paypal/errors";
import {
  cancelUnclaimedItem,
  createPayout,
  duplicateBatchId,
  getPayoutBatch,
  getPayoutItem,
  payoutIds,
} from "@/server/paypal/payouts";

export const dynamic = "force-dynamic";

const PAYPAL_ID = /^[A-Z0-9-]{5,40}$/;
const input = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("payout"),
    technician: z.enum(["maya", "luis"]),
    testCode: z.enum(["", "ERRPYO002", "ERRPYO005", "ERRPYO010"]).default(""),
  }),
  z.object({ action: z.literal("get_batch"), id: z.string().regex(PAYPAL_ID) }),
  z.object({ action: z.literal("get_item"), id: z.string().regex(PAYPAL_ID) }),
  z.object({ action: z.literal("cancel_item"), id: z.string().regex(PAYPAL_ID) }),
]);

/** Fixed lab payout amount, set on the server (SPEC §9.1). */
const LAB_PAYOUT_CENTS = 500;

export async function POST(request: Request) {
  const denied = await labApiGuard(request);
  if (denied) return denied;

  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: { issue: "INVALID_INPUT" } }, { status: 400 });
  const body = parsed.data;
  const client = getPayPalClient();

  try {
    switch (body.action) {
      case "payout": {
        const envKey = body.technician === "maya" ? "TECH_PAYOUT_EMAIL_MAYA" : "TECH_PAYOUT_EMAIL_LUIS";
        const receiverEmail = readVar(process.env, envKey);
        if (!receiverEmail) return Response.json({ error: { issue: `${envKey}_NOT_SET` } }, { status: 400 });
        const { senderBatchId, senderItemId } = payoutIds({
          instanceId: client.instanceId,
          source: "lab",
          sourceId: randomUUID().slice(0, 8),
          technicianKey: body.technician,
          attempt: 1,
        });
        try {
          const result = await createPayout(
            client,
            {
              senderBatchId,
              senderItemId,
              receiverEmail,
              amountCents: LAB_PAYOUT_CENTS,
              currency: "USD",
              note: body.testCode || "Holdline lab payout",
              emailSubject: "Holdline lab payout",
              emailMessage: "Sandbox test payout from the Holdline lab.",
            },
            { allowTestCodes: true },
          );
          return Response.json({ senderBatchId, ...result });
        } catch (error) {
          const original = duplicateBatchId(error);
          if (original) return Response.json({ senderBatchId, duplicateOf: original });
          throw error;
        }
      }
      case "get_batch":
        return Response.json({ batch: await getPayoutBatch(client, body.id) });
      case "get_item":
        return Response.json({ item: await getPayoutItem(client, body.id) });
      case "cancel_item":
        return Response.json({
          item: await cancelUnclaimedItem(client, body.id, {
            requestId: client.requestId("lab", "payout-cancel", body.id),
          }),
        });
    }
  } catch (error) {
    if (error instanceof PayPalApiError) {
      return Response.json({
        error: { status: error.status, name: error.errorName, issue: error.issue, debugId: error.debugId },
      });
    }
    throw error;
  }
}
