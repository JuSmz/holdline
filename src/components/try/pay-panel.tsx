"use client";

import { PayPalOneTimePaymentButton, PayPalProvider } from "@paypal/react-paypal-js/sdk-v6";
import { Check, Copy, Smartphone } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { PanelState } from "@/server/try/state";

export type PanelBooking = {
  id: string;
  ref: string;
  panel: PanelState;
  serviceName: string;
  appointment: string;
  technicianFirstName: string;
  holdAmount: string;
  noShowFee: string;
};

export type PanelEndpoints = { order: string; authorize: string; mockApprove: string; deviceLink?: string };

type Props = {
  booking: PanelBooking;
  buyer: { email: string; password: string } | null;
  clientId: string | null;
  mocked: boolean;
  endpoints: PanelEndpoints;
  /** After a successful authorize (the chat asks the server to post the confirmation). */
  onAuthorized?: () => void;
};

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/**
 * The pay panel (SPEC §16): a PayPal AUTHORIZE hold in a popup (never redirect, which would end the
 * call), the sandbox buyer login, and "Open on my phone" with a fresh single-use link. The amount is
 * only displayed; the server takes it from the booking.
 */
export function PayPanel({ booking, buyer, clientId, mocked, endpoints, onAuthorized }: Props) {
  // This tab's latest result, until the server reports anything new (a webhook decline, an authorize
  // elsewhere): every change of the server state resets it, and a "processing" result expires.
  const [local, setLocal] = useState<PanelBooking["panel"] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [seen, setSeen] = useState(booking.panel);
  if (seen !== booking.panel) {
    setSeen(booking.panel);
    setLocal(null);
    setMessage(null);
  }
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<{ url: string; qrSvg: string } | null>(null);
  const [fallback, setFallback] = useState(false);
  const panel = local ?? booking.panel;
  const processingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setResult = (value: PanelBooking["panel"]) => {
    setLocal(value);
    if (processingTimer.current) clearTimeout(processingTimer.current);
    processingTimer.current = null;
    if (value === "processing") {
      // PayPal may review an approval for a while; after 20 s the server's state (polled) decides.
      processingTimer.current = setTimeout(() => {
        setLocal((v) => (v === "processing" ? null : v));
        setMessage(null);
      }, 20_000);
    }
  };

  async function authorized(data: Record<string, unknown> | null, status: number) {
    const result = String(data?.status ?? "");
    if (status === 200 && result === "authorized") {
      setResult("authorized");
      setMessage(null);
      onAuthorized?.();
    } else if (result === "declined_retry") {
      setResult("declined_retry");
      setMessage("PayPal didn't accept that payment method — you can try another one.");
    } else if (result === "processing" || status === 202) {
      setResult("processing");
      setMessage("PayPal is still processing the approval…");
    } else {
      setMessage(String(data?.message ?? "Something went wrong. Please try again."));
    }
  }

  async function openOnPhone() {
    if (!endpoints.deviceLink) return;
    const { data } = await post(endpoints.deviceLink);
    if (data?.ok) setDevice({ url: String(data.url), qrSvg: String(data.qrSvg) });
    else setMessage("Couldn't create a phone link right now.");
  }

  if (panel === "authorized") {
    return (
      <section
        className="rounded-xl border border-emerald-600/30 bg-emerald-50 p-5 dark:bg-emerald-950/30"
        aria-live="polite"
      >
        <p className="flex items-center gap-2 font-semibold text-emerald-800 dark:text-emerald-300">
          <Check className="size-5" /> Hold approved
        </p>
        <p className="mt-1 text-sm">
          {booking.holdAmount} is on hold for {booking.serviceName}, {booking.appointment}.{" "}
          {booking.technicianFirstName} will be there. Nothing is charged until the job is done.
        </p>
      </section>
    );
  }
  if (
    panel === "expired" ||
    panel === "done" ||
    panel === "late_cancel" ||
    panel === "no_show" ||
    panel === "fee_pending" ||
    panel === "missed" ||
    panel === "cancelled"
  ) {
    const text = {
      expired: ["The payment window has closed", "Ask the agent for a new time and a new link."],
      done: ["This job is done", "Thank you for choosing us!"],
      late_cancel: [
        "This appointment was cancelled late",
        `The ${booking.noShowFee} late-cancellation fee was charged; the rest of the hold was released.`,
      ],
      no_show: [
        "Nobody was home for the visit",
        `The ${booking.noShowFee} no-show fee was charged; the rest of the hold was released.`,
      ],
      fee_pending: [
        "This visit won't go ahead",
        `The business is settling the ${booking.noShowFee} fee; until then the hold stays on your PayPal account.`,
      ],
      missed: ["Nobody was home for the visit", "No fee was charged and the hold was released."],
      cancelled: ["This appointment was cancelled", "The hold is released; nothing is charged."],
    }[panel];
    return (
      <section className="rounded-xl border p-5" aria-live="polite">
        <p className="font-semibold">{text[0]}</p>
        <p className="mt-1 text-sm text-muted-foreground">{text[1]}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border p-5" aria-label="Approve the PayPal hold">
      <p className="text-sm font-medium text-brand">
        {panel === "reapprove" ? "Your hold needs to be approved again" : "Step 2 · Approve the hold"}
      </p>
      <h2 className="mt-1 text-lg font-semibold">
        {booking.holdAmount} hold · {booking.ref}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {booking.serviceName}, {booking.appointment} with {booking.technicianFirstName}. This is a hold, not a charge:
        PayPal reserves the amount and the business charges it only after the job. No-show fee {booking.noShowFee}; free
        cancellation up to 24 hours before.
      </p>

      {buyer ? (
        <div className="mt-4 rounded-lg bg-muted p-3 text-sm">
          <p className="font-medium">PayPal sandbox buyer (test money only)</p>
          <CopyRow label="Email" value={buyer.email} />
          <CopyRow label="Password" value={buyer.password} />
        </div>
      ) : null}

      <div className="mt-4 max-w-xs">
        {panel === "processing" ? (
          <p className="text-sm">PayPal is processing the approval…</p>
        ) : mocked ? (
          <Button
            className="w-full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const { status, data } = await post(endpoints.mockApprove);
                await authorized(data, status);
              } finally {
                setBusy(false);
              }
            }}
          >
            Approve with PayPal (sandbox mock)
          </Button>
        ) : clientId ? (
          <PayPalProvider
            clientId={clientId}
            environment="sandbox"
            components={["paypal-payments"]}
            pageType="checkout"
          >
            <PayPalOneTimePaymentButton
              presentationMode="popup"
              createOrder={async () => {
                const { data } = await post(endpoints.order);
                const orderId = typeof data?.orderId === "string" ? data.orderId : null;
                if (!orderId) {
                  setMessage(String(data?.message ?? "Couldn't start PayPal. Please try again."));
                  throw new Error("order creation failed");
                }
                return { orderId };
              }}
              onApprove={async ({ orderId }) => {
                const { status, data } = await post(endpoints.authorize, { orderId });
                await authorized(data, status);
              }}
              onCancel={() => setMessage("PayPal was closed before approving. You can try again.")}
              onError={() => {
                // A blocked or failed popup: never fall back to a redirect mid-call (SPEC §16).
                setFallback(true);
                setMessage("The PayPal window couldn't open here.");
              }}
            />
          </PayPalProvider>
        ) : (
          <p className="text-sm text-muted-foreground">PayPal isn&apos;t configured.</p>
        )}
      </div>

      {message || panel === "declined_retry" ? (
        <p className="mt-3 text-sm" role="status">
          {message ?? "PayPal didn't accept that payment method — you can try another one."}
        </p>
      ) : null}

      {endpoints.deviceLink ? (
        <div className="mt-4">
          {device ? (
            <div className="flex items-center gap-4">
              <div
                className="size-[168px] shrink-0 rounded bg-white"
                dangerouslySetInnerHTML={{ __html: device.qrSvg }}
              />
              <p className="text-sm">
                Scan to approve on your phone, or{" "}
                <a className="text-brand underline" href={device.url} target="_blank" rel="noopener">
                  open the pay page in a new tab
                </a>
                . The link works once.
              </p>
            </div>
          ) : (
            <Button variant={fallback ? "default" : "outline"} size="sm" onClick={openOnPhone}>
              <Smartphone /> {fallback ? "Open the pay page instead" : "Open on my phone"}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="mt-1 flex items-center justify-between gap-2">
      <span>
        {label}: <code className="text-xs">{value}</code>
      </span>
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </p>
  );
}
