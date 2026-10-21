"use client";

import { PayPalOneTimePaymentButton, PayPalProvider } from "@paypal/react-paypal-js/sdk-v6";
import { useRouter } from "next/navigation";
import { useState } from "react";

export type LabBookingView = {
  id: string;
  ref: string;
  service: string;
  slot: string;
  price: string;
  fee: string;
  status: string;
  flag: string | null;
  holdExpiresAt: string;
  events: string[];
  money: string[];
};

type Option = { key: string; label: string };
type Result = { at: string; label: string; data: unknown };

async function postJson(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as unknown };
}

const ACTIONS: { action: string; label: string; when: (b: LabBookingView) => boolean; confirm?: boolean }[] = [
  { action: "job_done", label: "Job done", when: (b) => b.status === "authorized", confirm: true },
  { action: "no_show", label: "No-show", when: (b) => b.status === "authorized", confirm: true },
  {
    action: "cancel",
    label: "Cancel",
    when: (b) => b.status === "authorized" || b.status === "pending_payment",
    confirm: true,
  },
  {
    action: "waive_fee",
    label: "Waive fee",
    when: (b) => b.status === "no_show" || (b.status === "cancelled" && b.flag === "capture_failed"),
  },
  { action: "retry_capture", label: "Retry capture", when: (b) => b.flag === "capture_failed" },
  { action: "bill_via_invoice", label: "Bill via invoice", when: (b) => b.flag === "capture_failed", confirm: true },
  { action: "retry_payout", label: "Retry payout", when: (b) => b.flag === "payout_failed" },
];

const PAYABLE = (b: LabBookingView) =>
  b.status === "pending_payment" ||
  (b.status === "authorized" && (b.flag === "reauth_failed" || b.flag === "hold_lost"));

export function LabBookings(props: {
  clientId: string;
  services: Option[];
  addons: Option[];
  defaultPayerEmail: string;
  bookings: LabBookingView[];
}) {
  const router = useRouter();
  const [serviceKey, setServiceKey] = useState(props.services[0]?.key ?? "");
  const [preferredDate, setPreferredDate] = useState("");
  const [payerEmail, setPayerEmail] = useState(props.defaultPayerEmail);
  const [addonKey, setAddonKey] = useState(props.addons[0]?.key ?? "");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[]>([]);

  const push = (label: string, data: unknown) =>
    setResults((prev) => [{ at: new Date().toLocaleTimeString(), label, data }, ...prev].slice(0, 25));

  async function run(label: string, url: string, body?: unknown) {
    setBusy(true);
    try {
      const { status, data } = await postJson(url, body);
      push(`${label} (${status})`, data);
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  const button = "h-9 rounded-lg border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50";
  const field = "mt-1 h-10 w-full rounded-lg border bg-background px-3 text-sm";

  return (
    <div className="space-y-6">
      <section className="grid gap-4 rounded-xl border p-6 md:grid-cols-4">
        <label className="text-sm">
          Service
          <select className={field} value={serviceKey} onChange={(e) => setServiceKey(e.target.value)}>
            {props.services.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Preferred date (optional)
          <input
            className={field}
            type="date"
            value={preferredDate}
            onChange={(e) => setPreferredDate(e.target.value)}
          />
        </label>
        <label className="text-sm">
          Sandbox buyer email
          <input className={field} value={payerEmail} onChange={(e) => setPayerEmail(e.target.value)} />
        </label>
        <div className="flex items-end gap-2">
          <button
            type="button"
            className={button}
            disabled={busy || !payerEmail}
            onClick={() =>
              run("create booking", "/api/lab/bookings", {
                serviceKey,
                payerEmail,
                ...(preferredDate ? { preferredDate } : {}),
              })
            }
          >
            Create booking
          </button>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => run("tick", "/api/lab/bookings/tick")}
          >
            Run tick
          </button>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {props.bookings.map((b) => (
          <article key={b.id} className="rounded-xl border p-5">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="font-mono font-semibold">{b.ref}</h2>
              <span className="text-sm">
                <span className="font-medium">{b.status}</span>
                {b.flag ? <span className="ml-2 text-red-600">● {b.flag}</span> : null}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {b.service} · {b.slot} · {b.price} (no-show fee {b.fee})
            </p>
            {PAYABLE(b) && props.clientId ? (
              <div className="mt-3 max-w-xs">
                <PayPalProvider
                  clientId={props.clientId}
                  environment="sandbox"
                  components={["paypal-payments"]}
                  pageType="checkout"
                >
                  <PayPalOneTimePaymentButton
                    presentationMode="popup"
                    createOrder={async () => {
                      const { data } = await postJson(`/api/lab/bookings/${b.id}/order`);
                      push(`${b.ref} order`, data);
                      const orderId = (data as { orderId?: string } | null)?.orderId;
                      if (!orderId) throw new Error("order creation failed");
                      return { orderId };
                    }}
                    onApprove={async ({ orderId }) => {
                      await run(`${b.ref} authorize`, `/api/lab/bookings/${b.id}/authorize`, { orderId });
                    }}
                    onCancel={() => push(`${b.ref} popup closed`, null)}
                    onError={(error) => push(`${b.ref} sdk error`, { code: error.code, message: error.message })}
                  />
                </PayPalProvider>
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {ACTIONS.filter((a) => a.when(b)).map((a) => (
                <button
                  key={a.action}
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() => {
                    if (a.confirm && !window.confirm(`${a.label} on ${b.ref}?`)) return;
                    void run(`${b.ref} ${a.action}`, `/api/lab/bookings/${b.id}/action`, { action: a.action });
                  }}
                >
                  {a.label}
                </button>
              ))}
              {["completed", "captured", "paid_out"].includes(b.status) ? (
                <span className="flex items-center gap-2">
                  <select
                    className="h-9 rounded-lg border bg-background px-2 text-sm"
                    value={addonKey}
                    onChange={(e) => setAddonKey(e.target.value)}
                  >
                    {props.addons.map((a) => (
                      <option key={a.key} value={a.key}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      run(`${b.ref} extra work`, `/api/lab/bookings/${b.id}/action`, {
                        action: "extra_work",
                        addonKey,
                        quantity: 1,
                      })
                    }
                  >
                    Bill extra work
                  </button>
                </span>
              ) : null}
            </div>
            {b.money.length > 0 ? (
              <ul className="mt-3 space-y-0.5 font-mono text-xs">
                {b.money.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : null}
            <ol className="mt-3 space-y-0.5 font-mono text-xs text-muted-foreground">
              {b.events.map((e, i) => (
                <li key={`${i}-${e}`}>{e}</li>
              ))}
            </ol>
          </article>
        ))}
      </div>

      <section className="rounded-xl border p-6">
        <h2 className="font-semibold">Results</h2>
        <ol className="mt-3 space-y-3">
          {results.map((r, i) => (
            <li key={`${r.at}-${i}`} className="text-sm">
              <span className="text-muted-foreground">{r.at}</span> <span className="font-medium">{r.label}</span>
              <pre className="mt-1 overflow-x-auto text-xs">{JSON.stringify(r.data, null, 2)}</pre>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
