"use client";

import { cn } from "cn";
import { ExternalLink, MessageCircle, Minus, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import { PAYMENT_FLAG, Pill, StatusPill } from "@/components/ui/status-pill";
import type { ActionKey } from "@/server/dashboard/actions";

import {
  type AddonOption,
  actionLabel,
  extraWorkPending,
  extraWorkTotal,
  MAX_INVOICE_LABEL,
  overInvoiceCap,
  type PendingAction,
  PRIMARY_ACTIONS,
  pendingFor,
  replyTone,
  sendAction,
} from "./booking-actions";
import { AmountCell, type BookingDetailJson, CopyId, Fact, type Row, SampleTag, Section, TONE_TEXT } from "./shared";
import { useDetail } from "./use-live";

export type BookingTarget = { id: string; action?: ActionKey; nonce: number };

type Notify = (text: string, tone: "success" | "info" | "danger") => void;

/**
 * The booking sheet (SPEC §18): summary, the actions that apply now, the timeline in plain English and
 * every PayPal object with its ID. Updates in place on each dashboard poll.
 */
export function BookingSheet({
  target,
  open,
  onOpenChange,
  rows,
  addons,
  tick,
  onNotify,
  onChanged,
  onOpenCall,
}: {
  target: BookingTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: Row[];
  addons: AddonOption[];
  tick: number;
  onNotify: Notify;
  onChanged: () => void;
  onOpenCall: (callId: string) => void;
}) {
  const {
    data: detail,
    missing,
    reload,
  } = useDetail<BookingDetailJson>(target ? `/api/dashboard/bookings/${target.id}` : null, tick, open);
  const row = detail?.booking ?? rows.find((r) => r.id === target?.id) ?? null;
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={row?.serviceName ?? "Booking"}
      description={row ? `${row.day} · ${row.time}` : undefined}
    >
      {missing ? (
        <Notice tone="neutral">This booking isn&apos;t in your demo copy any more.</Notice>
      ) : target && row ? (
        <BookingBody
          key={`${target.id}:${target.nonce}`}
          row={row}
          detail={detail}
          initialAction={target.action}
          addons={addons}
          onNotify={onNotify}
          onChanged={() => {
            reload();
            onChanged();
          }}
          onOpenCall={onOpenCall}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </Sheet>
  );
}

function BookingBody({
  row,
  detail,
  initialAction,
  addons,
  onNotify,
  onChanged,
  onOpenCall,
}: {
  row: Row;
  detail: BookingDetailJson | null;
  initialAction?: ActionKey;
  addons: AddonOption[];
  onNotify: Notify;
  onChanged: () => void;
  onOpenCall: (callId: string) => void;
}) {
  const startsWithAction = initialAction && row.actions.includes(initialAction) && !row.busy;
  const [pending, setPending] = useState<PendingAction | null>(() =>
    startsWithAction && initialAction !== "extra_work" ? pendingFor(row, initialAction) : null,
  );
  const [extraOpen, setExtraOpen] = useState(Boolean(startsWithAction && initialAction === "extra_work"));
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "danger" } | null>(null);

  const ask = (key: ActionKey) => {
    setNotice(null);
    if (key === "extra_work") {
      setExtraOpen(true);
      return;
    }
    setPending(pendingFor(row, key));
  };

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    const reply = await sendAction(row.id, pending.body);
    setBusy(false);
    setPending(null);
    if (reply.ok) {
      onNotify(reply.message, replyTone(pending.key, reply));
      setNotice(null);
      setExtraOpen(false);
      setQuantities({});
    } else {
      setNotice({ text: reply.message, tone: reply.inProgress ? "info" : "danger" });
    }
    onChanged();
  }

  // While the extra-work picker is open, its own button is the next step.
  const actions = extraOpen ? row.actions.filter((a) => a !== "extra_work") : row.actions;
  const disabled = row.busy || busy;
  const flagLine = row.flag ? (PAYMENT_FLAG[row.flag] ?? "Payment needs attention") : null;
  const waiting = row.flag === "capture_pending" || row.flag === "authorization_pending";

  return (
    <div className="space-y-7 pb-4">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2" aria-live="polite">
          <span data-testid="sheet-status">
            <StatusPill status={row.status} flag={row.flag} />
          </span>
          {row.sample ? <SampleTag /> : null}
        </div>
        <CopyId label="Booking" value={row.ref} />
        {flagLine ? <Notice tone={waiting ? "warning" : "danger"}>{flagLine}</Notice> : null}
      </div>

      {row.sample ? (
        <Notice tone="neutral">Sample history is read-only. Book a job as the customer to try the actions.</Notice>
      ) : actions.length > 0 ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {actions.map((key, i) => (
              <Button
                key={key}
                variant={
                  // While the extra-work picker is open, "Review invoice" is the one primary.
                  i === 0 && PRIMARY_ACTIONS.has(key) && !extraOpen
                    ? "default"
                    : key === "cancel" && row.status === "authorized"
                      ? "destructive"
                      : "secondary"
                }
                disabled={disabled}
                aria-expanded={key === "extra_work" ? extraOpen : undefined}
                onClick={() => ask(key)}
              >
                {actionLabel(row, key)}
              </Button>
            ))}
          </div>
          {row.busy ? <Notice tone="info">PayPal is working on this… The page updates on its own.</Notice> : null}
          {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
        </div>
      ) : notice ? (
        <Notice tone={notice.tone}>{notice.text}</Notice>
      ) : row.busy ? (
        <Notice tone="info">PayPal is working on this… The page updates on its own.</Notice>
      ) : null}

      {extraOpen && row.actions.includes("extra_work") ? (
        <ExtraWork
          addons={addons}
          quantities={quantities}
          disabled={disabled}
          onChange={setQuantities}
          onCancel={() => {
            setExtraOpen(false);
            setQuantities({});
          }}
          onReview={() => setPending(extraWorkPending(addons, quantities))}
        />
      ) : null}

      <Section title="Summary">
        <dl className="divide-y divide-border rounded-2xl bg-canvas px-4">
          <Fact label="When">
            {row.day}
            <span className="block text-sm text-muted-foreground tabular-nums">{row.time}</span>
          </Fact>
          <Fact label="Customer">
            {row.customer}
            {detail?.customerEmail ? (
              <span className="block truncate text-sm text-muted-foreground">{detail.customerEmail}</span>
            ) : null}
          </Fact>
          <Fact label="Technician">{detail?.technicianName ?? row.technician}</Fact>
          <Fact label="Amount">
            <AmountCell row={row} />
          </Fact>
          {detail?.problem ? (
            <Fact label="Problem">
              <span className="block text-left text-[15px] whitespace-pre-line">{detail.problem}</span>
            </Fact>
          ) : null}
        </dl>
        {detail?.call ? (
          <Button variant="link" className="text-sm" onClick={() => onOpenCall(detail.call!.id)}>
            <MessageCircle /> View the conversation
          </Button>
        ) : null}
      </Section>

      {detail ? (
        <>
          <Timeline items={detail.timeline} />
          <Payments payments={detail.payments} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Loading the timeline…</p>
      )}

      <ConfirmDialog
        spec={pending?.spec ?? null}
        open={pending !== null}
        busy={busy}
        onOpenChange={(next) => {
          if (!next && !busy) setPending(null);
        }}
        onConfirm={() => void confirm()}
      />
    </div>
  );
}

function ExtraWork({
  addons,
  quantities,
  disabled,
  onChange,
  onCancel,
  onReview,
}: {
  addons: AddonOption[];
  quantities: Record<string, number>;
  disabled: boolean;
  onChange: (q: Record<string, number>) => void;
  onCancel: () => void;
  onReview: () => void;
}) {
  const set = (key: string, n: number) => onChange({ ...quantities, [key]: Math.max(0, Math.min(20, n)) });
  const any = Object.values(quantities).some((n) => n > 0);
  const overCap = overInvoiceCap(addons, quantities);
  return (
    <Section title="Extra work">
      <div className="rounded-2xl border border-border">
        <ul className="divide-y divide-border">
          {addons.map((a) => {
            const n = quantities[a.key] ?? 0;
            return (
              <li key={a.key} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[15px]">{a.name}</p>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {a.price} per {a.unit}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1" role="group" aria-label={`Quantity of ${a.name}`}>
                  <Button
                    size="icon-sm"
                    variant="secondary"
                    aria-label={`One less ${a.name}`}
                    disabled={disabled || n === 0}
                    onClick={() => set(a.key, n - 1)}
                  >
                    <Minus />
                  </Button>
                  <span className="w-6 text-center tabular-nums" aria-live="polite">
                    {n}
                  </span>
                  <Button
                    size="icon-sm"
                    variant="secondary"
                    aria-label={`One more ${a.name}`}
                    disabled={disabled || n >= 20}
                    onClick={() => set(a.key, n + 1)}
                  >
                    <Plus />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-canvas px-4 py-3">
          <div>
            <p className="text-[15px]">
              Total{" "}
              <span className={cn("font-semibold tabular-nums", overCap && "text-danger")}>
                {extraWorkTotal(addons, quantities)}
              </span>
            </p>
            {overCap ? (
              <p className="text-sm text-danger" role="status">
                Invoices are limited to {MAX_INVOICE_LABEL}. Lower a quantity.
              </p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" disabled={disabled || !any || overCap} onClick={onReview}>
              Review invoice
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}

const DOT: Record<string, string> = {
  neutral: "bg-muted-foreground/40",
  brand: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

function Timeline({ items }: { items: BookingDetailJson["timeline"] }) {
  if (items.length === 0) return null;
  return (
    <Section title="Timeline">
      <ol className="relative space-y-4 pl-5 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-border">
        {items.map((e) => (
          <li key={e.id} className="relative">
            <span
              aria-hidden
              className={cn("absolute top-[7px] -left-5 size-[11px] rounded-full ring-4 ring-card", DOT[e.tone])}
            />
            <p className="text-[15px]">{e.text}</p>
            <p className="text-sm text-muted-foreground">
              {e.atLabel} · {e.actor}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Payments({ payments }: { payments: BookingDetailJson["payments"] }) {
  const empty =
    payments.orders.length +
      payments.authorizations.length +
      payments.captures.length +
      payments.invoices.length +
      payments.payouts.length ===
    0;
  if (empty) return null;
  return (
    <Section title="PayPal">
      <div className="space-y-2">
        {payments.authorizations.map((a) => (
          <Item key={a.id} title={a.renewalOf ? "Renewed hold" : "Hold"} amount={a.amount} status={a.status}>
            <CopyId label="Authorization" value={a.id} />
            {a.renewalOf ? <CopyId label="Renewal of" value={a.renewalOf} /> : null}
            {a.role ? <span className="text-xs text-muted-foreground">{a.role}</span> : null}
            {a.validUntil && a.status === "On hold" ? (
              <span className="text-xs text-muted-foreground">Valid until {a.validUntil}</span>
            ) : null}
          </Item>
        ))}
        {payments.captures.map((c) => (
          <Item key={c.id} title={c.title} amount={c.amount} status={c.status} at={c.atLabel}>
            <CopyId label="Capture" value={c.id} />
          </Item>
        ))}
        {payments.invoices.map((i) => (
          <Item key={i.number} title={i.title} amount={i.paid ?? i.total} status={i.status} at={i.atLabel}>
            <ul className="text-sm text-muted-foreground">
              {i.items.map((l, n) => (
                <li key={n} className="flex justify-between gap-3 tabular-nums">
                  <span>
                    {l.quantity} × {l.name}
                  </span>
                  <span>{l.amount}</span>
                </li>
              ))}
            </ul>
            <CopyId label="Invoice no." value={i.number} />
            <CopyId label="Invoice" value={i.id} />
            {i.payerViewUrl ? (
              <a
                href={i.payerViewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
              >
                Open what the customer sees <ExternalLink className="size-3.5" />
              </a>
            ) : null}
          </Item>
        ))}
        {payments.payouts.map((p) => (
          <Item
            key={p.id}
            title={`Payout to ${p.technician}`}
            amount={p.amount}
            pill={<Pill tone={p.status.tone}>{p.status.label}</Pill>}
            at={p.atLabel}
          >
            <span className="text-xs text-muted-foreground">
              {p.forWhat}
              {p.attempt > 1 ? ` · attempt ${p.attempt}` : ""}
            </span>
            <CopyId label="Batch" value={p.batchId} />
            <CopyId label="Item" value={p.itemId} />
          </Item>
        ))}
        {payments.orders.map((o) => (
          <Item
            key={o.id}
            title={`Order${o.attempt > 1 ? ` · try ${o.attempt}` : ""}`}
            amount={o.amount}
            status={o.status}
            at={o.atLabel}
          >
            <CopyId label="Order" value={o.id} />
          </Item>
        ))}
      </div>
    </Section>
  );
}

function Item({
  title,
  amount,
  status,
  pill,
  at,
  children,
}: {
  title: string;
  amount: string;
  status?: string;
  pill?: React.ReactNode;
  at?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 rounded-2xl bg-canvas px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[15px] font-medium">{title}</p>
        <p className="font-medium tabular-nums">{amount}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        {pill ?? (status ? <span className={TONE_TEXT.neutral}>{status}</span> : null)}
        {at ? <span>{at}</span> : null}
      </div>
      <div className="flex flex-col items-start gap-1">{children}</div>
    </div>
  );
}
