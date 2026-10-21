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

  const push = (label: string, data: unknown) =>
    setResults((prev) => [{ at: new Date().toLocaleTimeString(), label, data }, ...prev].slice(0, 20));

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
