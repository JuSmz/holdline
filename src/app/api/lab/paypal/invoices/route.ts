import { randomUUID } from "node:crypto";

import { z } from "zod";

import { readVar } from "@/server/config/env";
import { labApiGuard } from "@/server/lab";
import { getPayPalClient } from "@/server/paypal";
import { PayPalApiError } from "@/server/paypal/errors";
import {
  cancelInvoice,
  createInvoice,
  findInvoiceByNumber,
  getInvoice,
  isFullyPaid,
  sendInvoice,
} from "@/server/paypal/invoicing";

export const dynamic = "force-dynamic";

const INVOICE_ID = /^INV2(-[A-Z0-9]{4}){4}$/;
const input = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_send"),
    // Sandbox test accounts only — the lab never invoices a real address.
    recipientEmail: z
      .string()
      .email()
      .refine((e) => e.toLowerCase().endsWith(".example.com"), "sandbox (*.example.com) addresses only"),
  }),
  z.object({ action: z.literal("get"), id: z.string().regex(INVOICE_ID) }),
  z.object({ action: z.literal("search"), invoiceNumber: z.string().regex(/^[A-Za-z0-9-]{1,25}$/) }),
  z.object({ action: z.literal("cancel"), id: z.string().regex(INVOICE_ID) }),
]);

/** Fixed lab extra-work items, set on the server (SPEC §9.1): $25 + $15 = $40. */
const LAB_ITEMS = [
  { name: "Replace shut-off valve", quantity: 1, unitAmountCents: 2500 },
  { name: "Extra labor (30 min)", quantity: 1, unitAmountCents: 1500 },
];

function summarize(invoice: Awaited<ReturnType<typeof getInvoice>>) {
  return {
    id: invoice.id,
    status: invoice.status,
    invoiceNumber: invoice.detail.invoice_number ?? null,
    total: invoice.amount ?? null,
    paid: invoice.payments?.paid_amount ?? null,
    fullyPaid: isFullyPaid(invoice),
    payerViewUrl: invoice.detail.metadata?.recipient_view_url ?? null,
  };
}

export async function POST(request: Request) {
  const denied = await labApiGuard(request);
  if (denied) return denied;

  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: { issue: "INVALID_INPUT", detail: parsed.error.issues[0]?.message } },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const client = getPayPalClient();

  try {
    switch (body.action) {
      case "create_send": {
        const invoicerEmail = readVar(process.env, "PAYPAL_BUSINESS_EMAIL");
        if (!invoicerEmail)
          return Response.json({ error: { issue: "PAYPAL_BUSINESS_EMAIL_NOT_SET" } }, { status: 400 });
        const invoiceNumber = `${client.instanceId}-LAB-${randomUUID().slice(0, 8)}`;
        const created = await createInvoice(client, {
          invoiceNumber,
          currency: "USD",
          invoicerEmail,
          invoicerBusinessName: "Holdline Lab",
          recipientEmail: body.recipientEmail,
          items: LAB_ITEMS,
          note: "Sandbox test invoice for extra work (Holdline lab).",
        });
        const sent = await sendInvoice(client, created.id);
        return Response.json({ invoiceNumber, created, sent, after: summarize(await getInvoice(client, created.id)) });
      }
      case "get":
        return Response.json({ invoice: summarize(await getInvoice(client, body.id)) });
      case "search": {
        const found = await findInvoiceByNumber(client, body.invoiceNumber);
        // Search rows are partial; GET the full invoice before summarizing.
        return Response.json({ invoice: found ? summarize(await getInvoice(client, found.id)) : null });
      }
      case "cancel":
        await cancelInvoice(client, body.id);
        return Response.json({ invoice: summarize(await getInvoice(client, body.id)) });
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
