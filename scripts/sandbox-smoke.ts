/**
 * Stage-3 sandbox smoke test (free sandbox calls, no buyer approval needed):
 *   1. $1 payout to Maya, then poll the batch until it settles
 *   2. payout negative test (items[0].note = ERRPYO005, insufficient funds)
 *   3. create + send a $40 invoice to a sandbox buyer, then find it by OUR invoice number
 * Usage: pnpm sandbox:smoke <sandbox-buyer-email>
 * Results are printed and logged to paypal_api_log in the local DB. Paying the invoice is a manual step.
 */
import { closeDb } from "../src/db/client";
import { readVar } from "../src/server/config/env";
import { getPayPalClient } from "../src/server/paypal";
import { PayPalApiError } from "../src/server/paypal/errors";
import { createInvoice, findInvoiceByNumber, getInvoice, sendInvoice } from "../src/server/paypal/invoicing";
import { createPayout, duplicateBatchId, getPayoutBatch, payoutIds } from "../src/server/paypal/payouts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const show = (label: string, value: unknown) => console.log(`\n== ${label}\n${JSON.stringify(value, null, 2)}`);
const err = (e: unknown) =>
  e instanceof PayPalApiError
    ? { status: e.status, name: e.errorName, issue: e.issue, debugId: e.debugId, details: e.details, links: e.links }
    : String(e);

async function main() {
  const buyer = process.argv[2];
  if (!buyer?.endsWith(".example.com"))
    throw new Error("usage: pnpm sandbox:smoke <sandbox buyer email (*.example.com)>");
  const maya = readVar(process.env, "TECH_PAYOUT_EMAIL_MAYA");
  const business = readVar(process.env, "PAYPAL_BUSINESS_EMAIL");
  if (!maya || !business) throw new Error("TECH_PAYOUT_EMAIL_MAYA and PAYPAL_BUSINESS_EMAIL must be set");

  const client = getPayPalClient();
  const run = Date.now().toString(36);

  // 1. Payout to Maya
  const { senderBatchId, senderItemId } = payoutIds({
    instanceId: client.instanceId,
    source: "smoke",
    sourceId: run,
    technicianKey: "maya",
    attempt: 1,
  });
  const payoutInput = {
    senderBatchId,
    senderItemId,
    receiverEmail: maya,
    amountCents: 100,
    currency: "USD" as const,
    note: "Holdline sandbox smoke payout",
    emailSubject: "Holdline smoke payout",
    emailMessage: "Sandbox smoke test.",
  };
  const payout = await createPayout(client, payoutInput);
  show("payout created", { senderBatchId, senderItemId, ...payout });
  for (let i = 0; i < 12; i += 1) {
    const batch = await getPayoutBatch(client, payout.payoutBatchId);
    const item = batch.items?.[0];
    show(`payout batch poll ${i + 1}`, {
      batchStatus: batch.batch_header.batch_status,
      itemId: item?.payout_item_id,
      itemStatus: item?.transaction_status,
      fees: batch.batch_header.fees,
    });
    if (["SUCCESS", "DENIED", "CANCELED"].includes(batch.batch_header.batch_status)) break;
    await sleep(5000);
  }

  // 1b. Duplicate sender_batch_id probe: same batch ID, fresh request ID → PayPal must refuse (no money moves)
  try {
    await createPayout(client, payoutInput, { requestIdOverride: client.requestId("payout-dup-probe", run) });
    show("duplicate sender_batch_id probe — UNEXPECTEDLY accepted", {});
  } catch (e) {
    show("duplicate sender_batch_id probe — rejected", { error: err(e), recoveredBatchId: duplicateBatchId(e) });
  }

  // 2. Payout negative test
  try {
    const negIds = payoutIds({
      instanceId: client.instanceId,
      source: "smoke",
      sourceId: `${run}neg`,
      technicianKey: "maya",
      attempt: 1,
    });
    const neg = await createPayout(
      client,
      {
        ...negIds,
        receiverEmail: maya,
        amountCents: 100,
        currency: "USD",
        note: "ERRPYO005",
        emailSubject: "Holdline smoke payout",
        emailMessage: "Negative test.",
      },
      { allowTestCodes: true },
    );
    show("payout negative test (ERRPYO005) — accepted", neg);
  } catch (e) {
    show("payout negative test (ERRPYO005) — rejected", err(e));
  }

  // 3. Invoice
  const invoiceNumber = `${client.instanceId}-SMK-${run}`.slice(0, 25);
  const created = await createInvoice(client, {
    invoiceNumber,
    currency: "USD",
    invoicerEmail: business,
    invoicerBusinessName: "Holdline Lab",
    recipientEmail: buyer,
    items: [
      { name: "Replace shut-off valve", quantity: 1, unitAmountCents: 2500 },
      { name: "Extra labor (30 min)", quantity: 1, unitAmountCents: 1500 },
    ],
    note: "Sandbox smoke invoice for extra work.",
  });
  show("invoice created", { invoiceNumber, ...created });
  const sent = await sendInvoice(client, created.id);
  show("invoice sent", sent);
  const found = await findInvoiceByNumber(client, invoiceNumber);
  show("invoice found by number", { id: found?.id, status: found?.status, matches: found?.id === created.id });
  const invoice = await getInvoice(client, created.id);
  show("invoice now", {
    status: invoice.status,
    total: invoice.amount,
    payerViewUrl: invoice.detail.metadata?.recipient_view_url ?? sent.payerViewUrl,
  });
  console.log(
    "\nNext: open the payer-view URL, log in as the buyer and pay. Then INVOICING.INVOICE.PAID arrives on Render.",
  );
}

main()
  .catch((error: unknown) => {
    console.error(err(error));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
