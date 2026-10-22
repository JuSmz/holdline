"use client";

import { PayPalOneTimePaymentButton, PayPalProvider } from "@paypal/react-paypal-js/sdk-v6";
import { cn } from "cn";
import {
  Ban,
  CalendarX2,
  Check,
  CircleCheck,
  Clock,
  Copy,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
  Smartphone,
  UserX,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { NEEDS_BUYER, type PanelState } from "@/server/try/panel";

export type PanelBooking = {
  id: string;
  ref: string;
  panel: PanelState;
  /** The booking status behind the panel state: a cancelled booking's hold is released only once it is `voided`. */
  status?: string;
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
  /** false inside a surface that is already a card (the bottom sheet, the /pay card). Default true. */
  framed?: boolean;
};

/** Panel states in which the buyer still has to act (or PayPal is still deciding); shared with the server. */
export { NEEDS_BUYER };

type Tone = "info" | "warning" | "danger";
type Note = { text: string; tone: Tone };

const NOTE_TONES: Record<Tone, string> = {
  info: "bg-canvas text-foreground",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

/** The calm end states, in the customer's words (the same texts as before the redesign). */
const FINAL: Partial<
  Record<
    PanelState,
    { icon: LucideIcon; tone: "success" | "neutral"; title: string; body: (b: PanelBooking) => string }
  >
> = {
  authorized: {
    icon: Check,
    tone: "success",
    title: "Hold approved",
    body: (b) =>
      `${b.holdAmount} is on hold for ${b.serviceName}, ${b.appointment}. ${b.technicianFirstName} will be there. Nothing is charged until the job is done.`,
  },
  done: { icon: CircleCheck, tone: "success", title: "This job is done", body: () => "Thank you for choosing us!" },
  late_cancel: {
    icon: CalendarX2,
    tone: "neutral",
    title: "This appointment was cancelled late",
    body: (b) => `The ${b.noShowFee} late-cancellation fee was charged; the rest of the hold was released.`,
  },
  no_show: {
    icon: UserX,
    tone: "neutral",
    title: "Nobody was home for the visit",
    body: (b) => `The ${b.noShowFee} no-show fee was charged; the rest of the hold was released.`,
  },
  fee_pending: {
    icon: Hourglass,
    tone: "neutral",
    title: "This visit won't go ahead",
    // Nothing about the hold: the fee may still be taken from it, or the hold was released and the
    // business sends a PayPal invoice instead.
    body: (b) => `The business is settling the ${b.noShowFee} fee; you won't be charged more than that.`,
  },
  missed: {
    icon: UserX,
    tone: "neutral",
    title: "Nobody was home for the visit",
    body: () => "No fee was charged and the hold was released.",
  },
  cancelled: {
    icon: Ban,
    tone: "neutral",
    title: "This appointment was cancelled",
    // Cancelled comes before PayPal released the hold (the void may still be running or be retried).
    body: (b) =>
      b.status === "voided"
        ? "The hold is released; nothing is charged."
        : "The hold is being released; nothing is charged.",
  },
  expired: {
    icon: Clock,
    tone: "neutral",
    title: "The payment window has closed",
    body: () => "Ask the agent for a new time and a new link.",
  },
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
 * call), the sandbox buyer login, and "Pay on my phone instead" with a fresh single-use link. The
 * amount is only displayed; the server takes it from the booking.
 */
export function PayPanel({ booking, buyer, clientId, mocked, endpoints, onAuthorized, framed = true }: Props) {
  // This tab's latest result, until the server reports anything new (a webhook decline, an authorize
  // elsewhere): every change of the server state resets it, and a "processing" result expires.
  const [local, setLocal] = useState<PanelBooking["panel"] | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [seen, setSeen] = useState(booking.panel);
  if (seen !== booking.panel) {
    setSeen(booking.panel);
    setLocal(null);
    setNote(null);
  }
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<{ url: string; qrSvg: string } | null>(null);
  const [linking, setLinking] = useState(false);
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
        setNote(null);
      }, 20_000);
    }
  };

  async function authorized(data: Record<string, unknown> | null, status: number) {
    const result = String(data?.status ?? "");
    if (status === 200 && result === "authorized") {
      setResult("authorized");
      setNote(null);
      onAuthorized?.();
    } else if (result === "declined_retry") {
      setResult("declined_retry");
      setNote({ text: "PayPal didn't accept that payment method — you can try another one.", tone: "warning" });
    } else if (result === "processing" || status === 202) {
      setResult("processing");
      setNote({ text: "PayPal is still processing the approval…", tone: "info" });
    } else {
      setNote({ text: String(data?.message ?? "Something went wrong. Please try again."), tone: "danger" });
    }
  }

  async function openOnPhone() {
    if (!endpoints.deviceLink || linking) return;
    setLinking(true);
    try {
      const { data } = await post(endpoints.deviceLink);
      if (data?.ok) setDevice({ url: String(data.url), qrSvg: String(data.qrSvg) });
      else setNote({ text: "Couldn't create a phone link right now.", tone: "danger" });
    } catch {
      setNote({ text: "Couldn't create a phone link right now.", tone: "danger" });
    } finally {
      setLinking(false);
    }
  }

  const final = FINAL[panel];
  const frame = framed ? "rounded-3xl border border-border bg-card p-5 shadow-card sm:p-6" : "";

  if (final) {
    const Icon = final.icon;
    return (
      <section
        className={cn(frame, framed && final.tone === "success" && "border-success/25")}
        aria-label={final.title}
        aria-live="polite"
      >
        <div className="flex flex-col items-center py-2 text-center motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-300">
          <span
            className={cn(
              "grid size-12 place-items-center rounded-full",
              final.tone === "success" ? "bg-success text-white" : "bg-neutral-soft text-muted-foreground",
            )}
          >
            <Icon className="size-6" strokeWidth={final.tone === "success" ? 2.5 : 2} aria-hidden />
          </span>
          <p className="mt-3 text-lg font-semibold tracking-tight">{final.title}</p>
          <p className="mt-1 max-w-sm text-sm text-pretty text-muted-foreground">{final.body(booking)}</p>
          <p className="mt-4 text-xs text-muted-foreground">
            Booking ref <span className="font-mono text-foreground">{booking.ref}</span>
          </p>
        </div>
      </section>
    );
  }

  const declined = panel === "declined_retry";
  // While processing, the "PayPal is confirming…" pill already says it.
  const shownNote: Note | null =
    panel === "processing" && note?.tone === "info"
      ? null
      : (note ??
        (declined
          ? { text: "PayPal didn't accept that payment method — you can try another one.", tone: "warning" }
          : null));

  return (
    <section className={frame} aria-label="Approve the PayPal hold" aria-live="polite">
      <p className="text-[13px] font-medium text-muted-foreground">
        {panel === "reapprove" ? "Your hold needs to be approved again" : "Approve the hold"}
      </p>
      <p className="mt-1 text-[40px] leading-[1.1] font-semibold tracking-tight tabular-nums">{booking.holdAmount}</p>
      <p className="mt-1.5 text-sm text-muted-foreground">Held on your PayPal account — charged only after the job.</p>

      <dl className="mt-5 divide-y divide-border rounded-2xl bg-canvas px-4 text-sm">
        <Row label="Service">{booking.serviceName}</Row>
        <Row label="When">{booking.appointment}</Row>
        <Row label="Technician">{booking.technicianFirstName}</Row>
        <Row label="Booking ref">
          <span className="font-mono text-[13px]">{booking.ref}</span>
        </Row>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        No-show fee {booking.noShowFee} · free cancellation up to 24 hours before.
      </p>

      {buyer ? (
        <div className="mt-5 rounded-2xl border border-border px-4 py-3">
          <p className="text-[13px] font-medium">PayPal sandbox buyer · test money</p>
          <p className="text-xs text-muted-foreground">Log in to PayPal with these.</p>
          <div className="mt-2 divide-y divide-border">
            <CopyRow label="Email" value={buyer.email} />
            <CopyRow label="Password" value={buyer.password} />
          </div>
        </div>
      ) : null}

      <div className="mt-5">
        {panel === "processing" ? (
          <p className="flex h-12 items-center justify-center gap-2 rounded-full bg-neutral-soft text-[15px] font-medium">
            <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden /> PayPal is confirming…
          </p>
        ) : mocked ? (
          <Button
            variant="dark"
            size="lg"
            className="w-full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const { status, data } = await post(endpoints.mockApprove);
                await authorized(data, status);
              } catch {
                setNote({ text: "Couldn't reach the server. Check your connection and try again.", tone: "danger" });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <>
                <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> Approving…
              </>
            ) : (
              "Approve with PayPal (sandbox)"
            )}
          </Button>
        ) : clientId ? (
          // The SDK renders its own button: its insertion is not news for screen readers.
          <div className="w-full [&>*]:w-full" aria-live="off">
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
                    setNote({
                      text: String(data?.message ?? "Couldn't start PayPal. Please try again."),
                      tone: "danger",
                    });
                    throw new Error("order creation failed");
                  }
                  return { orderId };
                }}
                onApprove={async ({ orderId }) => {
                  const { status, data } = await post(endpoints.authorize, { orderId });
                  await authorized(data, status);
                }}
                onCancel={() =>
                  setNote({ text: "PayPal was closed before approving. You can try again.", tone: "info" })
                }
                onError={() => {
                  // A blocked or failed popup: never fall back to a redirect mid-call (SPEC §16).
                  setFallback(true);
                  setNote({ text: "The PayPal window couldn't open here.", tone: "warning" });
                }}
              />
            </PayPalProvider>
          </div>
        ) : (
          <p className="rounded-2xl bg-canvas px-4 py-3 text-sm text-muted-foreground">PayPal isn&apos;t configured.</p>
        )}
      </div>

      {shownNote ? (
        <p className={cn("mt-3 rounded-2xl px-4 py-3 text-sm", NOTE_TONES[shownNote.tone])}>{shownNote.text}</p>
      ) : null}

      {endpoints.deviceLink ? (
        <div className="mt-3">
          {device ? (
            <div className="flex items-center gap-4 rounded-2xl bg-canvas p-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
              <div
                className="size-28 shrink-0 overflow-hidden rounded-xl bg-white p-1 [&_svg]:size-full"
                role="img"
                aria-label="QR code for the pay page"
                dangerouslySetInnerHTML={{ __html: device.qrSvg }}
              />
              <p className="text-sm">
                Scan with your phone&apos;s camera, or{" "}
                <a
                  className="font-medium text-brand underline-offset-4 hover:underline"
                  href={device.url}
                  target="_blank"
                  rel="noopener"
                >
                  open the pay page in a new tab
                </a>
                . The link works once.
              </p>
            </div>
          ) : fallback ? (
            <Button size="lg" className="w-full" disabled={linking} onClick={() => void openOnPhone()}>
              <Smartphone /> Open the pay page instead
            </Button>
          ) : (
            <Button
              variant="ghost"
              className="w-full text-muted-foreground hover:text-foreground"
              disabled={linking}
              onClick={() => void openOnPhone()}
            >
              <Smartphone /> {linking ? "Creating a phone link…" : "Pay on my phone instead"}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate font-mono text-[13px]">{value}</p>
      </div>
      <Button
        variant="secondary"
        size="icon-sm"
        aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => {});
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </div>
  );
}
