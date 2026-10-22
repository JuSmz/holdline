import { cn } from "cn";

export type Tone = "brand" | "success" | "warning" | "danger" | "neutral";

const TONES: Record<Tone, string> = {
  brand: "bg-brand-soft text-brand",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-neutral-soft text-muted-foreground",
};

/** Booking status → label and tone, as the owner sees it (docs/design-system.md). */
export const BOOKING_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_payment: { label: "Awaiting approval", tone: "warning" },
  authorized: { label: "Hold approved", tone: "brand" },
  completed: { label: "Charging", tone: "neutral" },
  no_show: { label: "No-show", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  captured: { label: "Charged", tone: "success" },
  paid_out: { label: "Paid out", tone: "success" },
  voided: { label: "Hold released", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

/** Payment flags as one short, true line: what the owner can do, or what happens next on its own. */
export const PAYMENT_FLAG: Record<string, string> = {
  authorization_pending: "Approval under review at PayPal",
  reauth_failed: "Hold renewal failed — the customer has to approve again",
  hold_lost: "Hold lost — the customer has to approve again",
  capture_failed: "Capture failed — retry or bill by invoice",
  capture_pending: "Capture pending at PayPal",
  payout_failed: "Payout failed — retry",
};

export function Pill({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current opacity-80" />
      {children}
    </span>
  );
}

export function StatusPill({ status, flag }: { status: string; flag?: string | null }) {
  const known = BOOKING_STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <span className="inline-flex items-center gap-1.5">
      <Pill tone={known.tone}>{known.label}</Pill>
      {flag ? (
        <span
          role="img"
          className="size-2 rounded-full bg-danger"
          title={PAYMENT_FLAG[flag] ?? "Payment needs attention"}
          aria-label={PAYMENT_FLAG[flag] ?? "Payment needs attention"}
        />
      ) : null}
    </span>
  );
}
