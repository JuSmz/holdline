"use client";

import { PayPalOneTimePaymentButton, PayPalProvider } from "@paypal/react-paypal-js/sdk-v6";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Result = { at: string; label: string; data: unknown };

const ACTIONS = [
  { action: "get", label: "GET authorization" },
  { action: "capture_full", label: "Capture full ($25, final)" },
  { action: "capture_partial_final", label: "Capture $10 + final_capture" },
  { action: "void", label: "Void" },
  { action: "reauthorize", label: "Reauthorize" },
] as const;

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as unknown };
}

const MONEY_ACTIONS = new Set(["capture_full", "capture_partial_final", "void", "reauthorize"]);

export function PayPalLab({
  clientId,
  recentAuthorizations,
}: {
  clientId: string;
  recentAuthorizations: { id: string; status: string }[];
}) {
  const router = useRouter();
  const [results, setResults] = useState<Result[]>([]);
  // Deliberately no preselection: the open holds kept for the reauthorization check must not be hit by accident.
  const [authorizationId, setAuthorizationId] = useState("");
  const [simulateDecline, setSimulateDecline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [technician, setTechnician] = useState<"maya" | "luis">("maya");
  const [testCode, setTestCode] = useState("");
  const [payoutId, setPayoutId] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");

  const push = (label: string, data: unknown) =>
    setResults((prev) => [{ at: new Date().toLocaleTimeString(), label, data }, ...prev].slice(0, 20));

  async function call(label: string, url: string, body: unknown, after?: (data: unknown) => void) {
    setBusy(true);
    try {
      const { data } = await postJson(url, body);
      push(label, data);
      after?.(data);
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  async function runAction(action: (typeof ACTIONS)[number]["action"]) {
    if (!authorizationId) return;
    if (MONEY_ACTIONS.has(action) && !window.confirm(`${action} on ${authorizationId}?`)) return;
    setBusy(true);
    try {
      const { data } = await postJson("/api/lab/paypal/action", { action, authorizationId });
      push(`${action} ${authorizationId}`, data);
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-xl border p-6">
        <h2 className="font-semibold">1 · Create &amp; approve an AUTHORIZE order ($25.00)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The server creates the order and sets the amount. Approve in the PayPal popup with a US sandbox buyer; the
          server then authorizes it.
        </p>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={simulateDecline} onChange={(e) => setSimulateDecline(e.target.checked)} />
          Negative test: authorize with <code>INSTRUMENT_DECLINED</code>
        </label>
        <div className="mt-4 max-w-xs">
          <PayPalProvider
            clientId={clientId}
            environment="sandbox"
            components={["paypal-payments"]}
            pageType="checkout"
          >
            <PayPalOneTimePaymentButton
              presentationMode="popup"
              createOrder={async () => {
                const { data } = await postJson("/api/lab/paypal/order");
                const orderId = (data as { orderId?: string } | null)?.orderId;
                push("create order", data);
                if (!orderId) throw new Error("order creation failed");
                return { orderId };
              }}
              onApprove={async ({ orderId }) => {
                const { data } = await postJson("/api/lab/paypal/authorize", { orderId, simulateDecline });
                push(`authorize ${orderId}`, data);
                const id = (data as { authorization?: { id?: string } } | null)?.authorization?.id;
                if (id) setAuthorizationId(id);
                router.refresh();
              }}
              onCancel={() => push("cancelled", null)}
              onError={(error) => push("sdk error", { code: error.code, message: error.message })}
            />
          </PayPalProvider>
        </div>
      </section>

      <section className="rounded-xl border p-6">
        <h2 className="font-semibold">2 · Act on an authorization</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Recent authorizations that are not captured or voided are listed below. Keep three of them open for the
          reauthorization check on or after 10-26.
        </p>
        <label className="mt-4 block text-sm font-medium" htmlFor="auth">
          Authorization ID
        </label>
        <input
          id="auth"
          list="open-auths"
          value={authorizationId}
          onChange={(e) => setAuthorizationId(e.target.value.trim())}
          className="mt-1 h-10 w-full rounded-lg border bg-background px-3 font-mono text-sm"
        />
        <datalist id="open-auths">
          {recentAuthorizations.map(({ id, status }) => (
            <option key={id} value={id} label={status} />
          ))}
        </datalist>
        {recentAuthorizations.length > 0 ? (
          <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
            {recentAuthorizations.map(({ id, status }) => (
              <li key={id}>
                <button
                  type="button"
                  className="font-mono underline-offset-2 hover:underline"
                  onClick={() => setAuthorizationId(id)}
                >
                  {id}
                </button>{" "}
                · last known: {status}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {ACTIONS.map(({ action, label }) => (
            <button
              key={action}
              type="button"
              disabled={busy || !authorizationId}
              onClick={() => runAction(action)}
              className="h-9 rounded-lg border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-xl border p-6">
        <h2 className="font-semibold">3 · Payouts (technician share)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sends a fixed $5.00 payout from the business account to a technician&apos;s sandbox account.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <select
            value={technician}
            onChange={(e) => setTechnician(e.target.value as "maya" | "luis")}
            className="h-9 rounded-lg border bg-background px-2"
          >
            <option value="maya">Maya</option>
            <option value="luis">Luis</option>
          </select>
          <select
            value={testCode}
            onChange={(e) => setTestCode(e.target.value)}
            className="h-9 rounded-lg border bg-background px-2"
          >
            <option value="">no test code</option>
            <option value="ERRPYO002">ERRPYO002 (sender email unconfirmed)</option>
            <option value="ERRPYO005">ERRPYO005 (insufficient funds)</option>
            <option value="ERRPYO010">ERRPYO010 (validation error)</option>
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              window.confirm(`Send a $5 payout to ${technician}?`) &&
              call(
                `payout ${technician} ${testCode}`.trim(),
                "/api/lab/paypal/payouts",
                { action: "payout", technician, testCode },
                (d) => {
                  const id = (d as { payoutBatchId?: string } | null)?.payoutBatchId;
                  if (id) setPayoutId(id);
                },
              )
            }
            className="h-9 rounded-lg border px-3 font-medium hover:bg-muted disabled:opacity-50"
          >
            Send $5 payout
          </button>
        </div>
        <label className="mt-4 block text-sm font-medium" htmlFor="payout-id">
          Payout batch or item ID
        </label>
        <input
          id="payout-id"
          value={payoutId}
          onChange={(e) => setPayoutId(e.target.value.trim())}
          className="mt-1 h-10 w-full rounded-lg border bg-background px-3 font-mono text-sm"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          {(
            [
              ["get_batch", "GET batch"],
              ["get_item", "GET item"],
              ["cancel_item", "Cancel unclaimed item"],
            ] as const
          ).map(([action, label]) => (
            <button
              key={action}
              type="button"
              disabled={busy || !payoutId}
              onClick={() => call(`${action} ${payoutId}`, "/api/lab/paypal/payouts", { action, id: payoutId })}
              className="h-9 rounded-lg border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-xl border p-6">
        <h2 className="font-semibold">4 · Invoices (extra work)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Creates and sends a fixed $40.00 invoice (valve $25 + labor $15) to a sandbox buyer. Pay it via the payer-view
          link while logged in as that buyer.
        </p>
        <label className="mt-4 block text-sm font-medium" htmlFor="recipient">
          Recipient (sandbox buyer email)
        </label>
        <input
          id="recipient"
          value={recipientEmail}
          onChange={(e) => setRecipientEmail(e.target.value.trim())}
          placeholder="sb-…@personal.example.com"
          className="mt-1 h-10 w-full rounded-lg border bg-background px-3 font-mono text-sm"
        />
        <button
          type="button"
          disabled={busy || !recipientEmail}
          onClick={() =>
            call(
              "create + send invoice",
              "/api/lab/paypal/invoices",
              { action: "create_send", recipientEmail },
              (d) => {
                const r = d as { created?: { id?: string }; invoiceNumber?: string } | null;
                if (r?.created?.id) setInvoiceId(r.created.id);
                if (r?.invoiceNumber) setInvoiceNumber(r.invoiceNumber);
              },
            )
          }
          className="mt-3 h-9 rounded-lg border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          Create + send $40 invoice
        </button>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <input
            aria-label="Invoice ID"
            value={invoiceId}
            onChange={(e) => setInvoiceId(e.target.value.trim())}
            placeholder="INV2-…"
            className="h-10 rounded-lg border bg-background px-3 font-mono text-sm"
          />
          <input
            aria-label="Invoice number"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value.trim())}
            placeholder="invoice number"
            className="h-10 rounded-lg border bg-background px-3 font-mono text-sm"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !invoiceId}
            onClick={() =>
              call(`get invoice ${invoiceId}`, "/api/lab/paypal/invoices", { action: "get", id: invoiceId })
            }
            className="h-9 rounded-lg border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            GET invoice
          </button>
          <button
            type="button"
            disabled={busy || !invoiceNumber}
            onClick={() =>
              call(`find invoice ${invoiceNumber}`, "/api/lab/paypal/invoices", { action: "search", invoiceNumber })
            }
            className="h-9 rounded-lg border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            Find by number
          </button>
          <button
            type="button"
            disabled={busy || !invoiceId}
            onClick={() =>
              window.confirm(`Cancel invoice ${invoiceId}?`) &&
              call(`cancel invoice ${invoiceId}`, "/api/lab/paypal/invoices", { action: "cancel", id: invoiceId })
            }
            className="h-9 rounded-lg border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            Cancel invoice
          </button>
        </div>
      </section>

      <section className="rounded-xl border p-6 lg:col-span-2">
        <h2 className="font-semibold">Results (this browser)</h2>
        {results.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">Nothing yet.</p> : null}
        <ol className="mt-3 space-y-3">
          {results.map((r, i) => (
            <li key={`${r.at}-${i}`} className="rounded-lg bg-muted p-3">
              <div className="text-xs text-muted-foreground">
                {r.at} · {r.label}
              </div>
              <pre className="mt-1 overflow-x-auto text-xs">{JSON.stringify(r.data, null, 2)}</pre>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
