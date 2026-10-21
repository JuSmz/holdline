import { centsToPayPal, payPalToCents, type Currency } from "@/server/money";

import { isUnknownOutcome, type PayPalClient } from "./client";
import { PayPalApiError, PayPalNetworkError } from "./errors";

/**
 * Invoicing v2 (SPEC §9.6). Invoicing does NOT honor PayPal-Request-Id, so our own
 * `invoice_number` (≤ 25 chars, instance-prefixed) is the dedup key: after an unknown outcome,
 * recover with `findInvoiceByNumber` instead of creating again.
 */

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "SCHEDULED"
  | "PAID"
  | "MARKED_AS_PAID"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_PAID"
  | "PARTIALLY_REFUNDED"
  | "MARKED_AS_REFUNDED"
  | "UNPAID"
  | "PAYMENT_PENDING"
  | "AUTO_CANCELLED"
  | "PAID_EXTERNAL"
  | "REFUNDED_EXTERNAL"
  | "SHARED";

export type Invoice = {
  id: string;
  status: InvoiceStatus;
  detail: { invoice_number?: string; currency_code: string; metadata?: { recipient_view_url?: string } };
  amount?: { currency_code: string; value: string };
  payments?: { paid_amount?: { currency_code: string; value: string } };
  links?: { href: string; rel: string; method?: string }[];
};

const INVOICE_NUMBER = /^[A-Za-z0-9-]{1,25}$/;

/** `<instance>-<ref>-X<n>`, e.g. `p1-HL7K3Q9-X1` (SPEC §10.4). */
/** `<instance>-<ref>-X<n>` for extra work, `-F<n>` for a fallback invoice (SPEC §9.6, §9.7). */
export function makeInvoiceNumber(instanceId: string, ref: string, n: number, kind: "X" | "F" = "X"): string {
  const number = `${instanceId}-${ref.replace(/[^A-Za-z0-9]/g, "")}-${kind}${n}`;
  if (!INVOICE_NUMBER.test(number)) throw new Error(`invoice number too long or invalid: ${number}`);
  return number;
}

export type InvoiceLine = { name: string; quantity: number; unitAmountCents: number };

/** Extra-work invoices are capped at $2,000 (SPEC §9.1); the §9.7 fallback passes its own cap. */
export const MAX_INVOICE_TOTAL_CENTS = 200_000;

export function invoiceTotalCents(items: InvoiceLine[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unitAmountCents, 0);
}

export type CreateInvoiceInput = {
  invoiceNumber: string;
  currency: Currency;
  invoicerEmail: string;
  invoicerBusinessName: string;
  recipientEmail: string;
  recipientName?: { givenName: string; surname?: string };
  items: InvoiceLine[];
  note?: string;
  maxTotalCents?: number;
};

export function invoiceBody(input: CreateInvoiceInput) {
  if (!INVOICE_NUMBER.test(input.invoiceNumber)) throw new Error(`invalid invoice number: ${input.invoiceNumber}`);
  if (input.items.length === 0) throw new Error("an invoice needs at least one item");
  let totalCents = 0;
  for (const item of input.items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) {
      throw new Error("item quantity must be an integer from 1 to 20");
    }
    if (!Number.isSafeInteger(item.unitAmountCents) || item.unitAmountCents <= 0) {
      throw new Error("item unit amount must be a positive integer number of cents");
    }
    totalCents += item.quantity * item.unitAmountCents;
  }
  if (totalCents > (input.maxTotalCents ?? MAX_INVOICE_TOTAL_CENTS)) {
    throw new Error(`invoice total ${totalCents} exceeds the cap`);
  }
  return {
    detail: {
      currency_code: input.currency,
      invoice_number: input.invoiceNumber,
      payment_term: { term_type: "DUE_ON_RECEIPT" },
      ...(input.note ? { note: input.note.slice(0, 4000) } : {}),
    },
    invoicer: { email_address: input.invoicerEmail, business_name: input.invoicerBusinessName.slice(0, 300) },
    primary_recipients: [
      {
        billing_info: {
          email_address: input.recipientEmail,
          ...(input.recipientName
            ? { name: { given_name: input.recipientName.givenName, surname: input.recipientName.surname ?? "" } }
            : {}),
        },
      },
    ],
    items: input.items.map((item) => ({
      name: item.name.slice(0, 200),
      quantity: String(item.quantity),
      unit_amount: { currency_code: input.currency, value: centsToPayPal(item.unitAmountCents) },
      unit_of_measure: "QUANTITY",
    })),
    configuration: { allow_tip: false, partial_payment: { allow_partial_payment: false } },
  };
}

function invoiceIdFrom(data: unknown): string | undefined {
  const d = data as { id?: string; href?: string } | null;
  if (d?.id) return d.id;
  const match = d?.href ? /\/v2\/invoicing\/invoices\/([A-Z0-9-]+)/.exec(d.href) : null;
  return match?.[1];
}

/**
 * POST /v2/invoicing/invoices → DRAFT invoice. Never auto-retried (Invoicing ignores PayPal-Request-Id).
 * On an unknown outcome or a 4xx (e.g. the number already exists) we look the invoice up by OUR number:
 * if it exists, that's our invoice; otherwise an unknown outcome stays unknown (SPEC §9.6, §10.3).
 */
export async function createInvoice(
  client: PayPalClient,
  input: CreateInvoiceInput,
): Promise<{ id: string; status: InvoiceStatus | null; recovered: boolean }> {
  if (!input.invoiceNumber.startsWith(`${client.instanceId}-`)) {
    throw new Error(`invoice number must start with the instance prefix "${client.instanceId}-"`);
  }
  const body = invoiceBody(input);
  try {
    const { data } = await client.post<Invoice & { href?: string }>("/v2/invoicing/invoices", body, {
      op: "invoicing.create",
      // Not honored by Invoicing; sent for uniformity and log correlation.
      requestId: client.requestId("invoice-create", input.invoiceNumber),
      retry: false,
      idsFrom: (d) => ({ invoiceId: invoiceIdFrom(d) ?? "", invoiceNumber: input.invoiceNumber }),
    });
    const id = invoiceIdFrom(data);
    if (!id) throw new PayPalNetworkError("PayPal returned no invoice ID");
    return { id, status: data?.status ?? null, recovered: false };
  } catch (error) {
    const recoverable =
      isUnknownOutcome(error) ||
      (error instanceof PayPalApiError && error.status >= 400 && error.status < 500 && error.status !== 401);
    if (!recoverable) throw error;
    const found = await findInvoiceByNumber(client, input.invoiceNumber);
    if (found) return { id: found.id, status: found.status, recovered: true };
    throw error;
  }
}

/** POST /v2/invoicing/invoices/{id}/send. Re-sending a sent invoice has no effect. Returns the payer-view URL. */
export async function sendInvoice(
  client: PayPalClient,
  invoiceId: string,
  options: { sendToRecipient?: boolean } = {},
): Promise<{ payerViewUrl: string | null }> {
  const { data } = await client.post<{ href?: string; rel?: string }>(
    `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`,
    { send_to_recipient: options.sendToRecipient ?? true, send_to_invoicer: false },
    {
      op: "invoicing.send",
      requestId: client.requestId("invoice-send", invoiceId),
      idsFrom: () => ({ invoiceId }),
    },
  );
  return { payerViewUrl: data?.href ?? null };
}

export async function getInvoice(client: PayPalClient, invoiceId: string): Promise<Invoice> {
  return client.get<Invoice>(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`, {
    op: "invoicing.get",
    idsFrom: () => ({ invoiceId }),
  });
}

/**
 * Recovery after an unknown create outcome: look the invoice up by OUR number (SPEC §9.6).
 * Search rows are partial — callers GET the invoice for amounts and payments.
 */
export async function findInvoiceByNumber(
  client: PayPalClient,
  invoiceNumber: string,
): Promise<{ id: string; status: InvoiceStatus; invoiceNumber: string } | null> {
  const { data } = await client.post<{ items?: Invoice[]; total_pages?: number }>(
    "/v2/invoicing/search-invoices?page=1&page_size=100&total_required=true",
    { invoice_number: invoiceNumber },
    {
      op: "invoicing.search",
      requestId: client.requestId("invoice-search", invoiceNumber),
      idsFrom: () => ({ invoiceNumber }),
    },
  );
  const match = data?.items?.find((invoice) => invoice.detail?.invoice_number === invoiceNumber);
  if (match) return { id: match.id, status: match.status, invoiceNumber };
  if ((data?.total_pages ?? 1) > 1) {
    throw new PayPalNetworkError(`invoice ${invoiceNumber} not on the first search page; outcome unknown`);
  }
  return null;
}

/** Cancels an invoice. Not auto-retried; after any error, a GET showing CANCELLED counts as success. */
export async function cancelInvoice(client: PayPalClient, invoiceId: string): Promise<void> {
  try {
    await client.post(
      `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/cancel`,
      { send_to_recipient: false, send_to_invoicer: false },
      {
        op: "invoicing.cancel",
        requestId: client.requestId("invoice-cancel", invoiceId),
        retry: false,
        idsFrom: () => ({ invoiceId }),
      },
    );
  } catch (error) {
    const after = await getInvoice(client, invoiceId).catch(() => null);
    if (after?.status === "CANCELLED") return;
    throw error;
  }
}

/**
 * An invoice counts as paid for payouts ONLY when PayPal says PAID and the paid amount equals the total
 * — never on PARTIALLY_PAID, PAYMENT_PENDING or MARKED_AS_PAID (SPEC §9.6).
 */
export function isFullyPaid(invoice: Invoice): boolean {
  if (invoice.status !== "PAID") return false;
  const total = invoice.amount?.value;
  const paid = invoice.payments?.paid_amount?.value;
  if (!total || !paid) return false;
  return payPalToCents(paid) === payPalToCents(total);
}
