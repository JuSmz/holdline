"use client";

import { cn } from "cn";
import {
  ArrowDownLeft,
  ArrowUpRight,
  BadgeCheck,
  Banknote,
  CalendarCheck,
  Check,
  CircleAlert,
  Copy,
  FileText,
  LockKeyhole,
  type LucideIcon,
  Unlock,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import type { Tone } from "@/components/ui/status-pill";
import type { BookingDetail, CallDetail, DashboardState } from "@/server/dashboard/queries";
import type { LineKind, LineTone } from "@/server/dashboard/wording";

export type State = DashboardState & { ok: true };
export type Row = State["bookings"][number];
export type BookingDetailJson = BookingDetail & { ok: true };
export type CallDetailJson = CallDetail & { ok: true };

/** The tone of a line, as Tailwind text and soft background classes. */
export const TONE_TEXT: Record<LineTone, string> = {
  neutral: "text-muted-foreground",
  brand: "text-brand",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export const TONE_SOFT: Record<LineTone, string> = {
  neutral: "bg-neutral-soft text-muted-foreground",
  brand: "bg-brand-soft text-brand",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export const toPillTone = (tone: LineTone): Tone => tone;

const KIND_ICON: Record<LineKind, LucideIcon> = {
  booking: CalendarCheck,
  hold: LockKeyhole,
  charge: ArrowDownLeft,
  release: Unlock,
  payout: ArrowUpRight,
  invoice: FileText,
  problem: CircleAlert,
  done: BadgeCheck,
};

/** A round icon for an activity or ledger line. */
export function LineIcon({ kind, tone, className }: { kind: LineKind; tone: LineTone; className?: string }) {
  const Icon = KIND_ICON[kind] ?? Banknote;
  return (
    <span
      aria-hidden
      className={cn("grid size-8 shrink-0 place-items-center rounded-full", TONE_SOFT[tone], className)}
    >
      <Icon className="size-4" />
    </span>
  );
}

/** "Sample" — read-only history every demo copy starts with. */
export function SampleTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full bg-neutral-soft px-2 text-[11px] font-medium text-muted-foreground",
        className,
      )}
    >
      Sample
    </span>
  );
}

/** A section inside a card or sheet: a small title and its content. */
export function Section({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A PayPal (or our own) identifier: mono, small, copyable (docs/design-system.md). */
export function CopyId({ label, value }: { label: string; value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <span className="inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <code className="truncate font-mono text-[11px] text-foreground/80">{value}</code>
      <button
        type="button"
        className="grid size-6 shrink-0 place-items-center rounded-full hover:bg-neutral-soft focus-visible:ring-4 focus-visible:ring-brand/25 focus-visible:outline-none"
        aria-label={`Copy ${label} ${value}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}

/** A label/value line in a summary list. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5 text-[15px]">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/** The amount column: the hold, and once charged, what was taken ("$39.00 no-show fee"). */
export function AmountCell({ row, align = "right" }: { row: Row; align?: "left" | "right" }) {
  return (
    <div className={cn("tabular-nums", align === "right" ? "text-right" : "text-left")}>
      {row.charged ? (
        <>
          <div className="font-medium">
            {row.charged.amount} <span className="font-normal text-muted-foreground">{row.charged.label}</span>
          </div>
          {row.charged.amount !== row.hold || row.charged.label !== "charged" ? (
            <div className="text-xs text-muted-foreground">of a {row.hold} hold</div>
          ) : (
            <div className="text-xs text-muted-foreground">in full</div>
          )}
        </>
      ) : (
        <>
          <div className="font-medium">{row.hold}</div>
          <div className="text-xs text-muted-foreground">hold</div>
        </>
      )}
      {row.extra ? <div className="mt-0.5 text-xs text-brand">{row.extra}</div> : null}
    </div>
  );
}
