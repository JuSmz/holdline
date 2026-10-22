"use client";

import { CalendarClock, CheckCircle2, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PAYMENT_FLAG, StatusPill } from "@/components/ui/status-pill";
import { Steps } from "@/components/ui/steps";
import type { ActionKey } from "@/server/dashboard/actions";

import { actionLabel } from "./booking-actions";
import { LineIcon, type Row, SampleTag, type State } from "./shared";

/** The actions that fix a flag, in the order the overview offers them. */
const FIXES: ActionKey[] = ["retry_capture", "retry_payout", "bill_via_invoice", "waive_fee"];

export function Overview({
  state,
  onOpenBooking,
  onSeeAll,
}: {
  state: State;
  onOpenBooking: (id: string, action?: ActionKey) => void;
  onSeeAll: () => void;
}) {
  const byId = new Map(state.bookings.map((b) => [b.id, b]));
  const attention = state.attention.flatMap((a) => {
    const row = byId.get(a.bookingId);
    return row ? [{ ...a, row }] : [];
  });
  const upcoming = state.upcoming.flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
  const activity = state.ledger.slice(0, 6);
  // Step 3 of the demo: the visitor's own newest booking that still waits for the owner (or the customer).
  const mine = state.bookings.find((r) => !r.sample && (r.status === "pending_payment" || r.status === "authorized"));

  return (
    <div className="space-y-6">
      {mine ? <YourBooking row={mine} onOpenBooking={onOpenBooking} /> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {state.kpis.map((k) => (
          <Card key={k.key} className="px-4 py-4 sm:px-5 sm:py-5">
            <p className="text-[13px] text-muted-foreground">{k.label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums sm:text-[28px]">{k.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{k.caption}</p>
            {k.sample ? <p className="text-xs text-muted-foreground/80">{k.sample}</p> : null}
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Card>
            <CardHeader>
              <CardTitle>Needs attention</CardTitle>
            </CardHeader>
            <CardContent className="pt-3">
              {attention.length === 0 ? (
                <p className="flex items-center gap-2 text-[15px] text-muted-foreground">
                  <CheckCircle2 className="size-4 text-success" /> All clear. Nothing needs you right now.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {attention.map((a) => {
                    const fix =
                      a.kind === "overdue"
                        ? ("job_done" as const)
                        : (FIXES.find((f) => a.row.actions.includes(f)) ?? null);
                    return (
                      <li
                        key={`${a.kind}-${a.bookingId}`}
                        className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                      >
                        <span aria-hidden className="size-2 shrink-0 rounded-full bg-danger" />
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:underline"
                          onClick={() => onOpenBooking(a.bookingId)}
                        >
                          <span className="block text-[15px] font-medium">
                            {a.kind === "overdue"
                              ? "The visit is over — mark it done or a no-show"
                              : (PAYMENT_FLAG[a.flag ?? ""] ?? "Payment needs attention")}
                          </span>
                          <span className="block truncate text-sm text-muted-foreground">
                            {a.row.serviceName} · {a.row.customer} · {a.row.day}
                          </span>
                        </button>
                        {fix && a.row.actions.includes(fix) && !a.row.busy ? (
                          <Button size="sm" variant="secondary" onClick={() => onOpenBooking(a.bookingId, fix)}>
                            {actionLabel(a.row, fix)}
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => onOpenBooking(a.bookingId)}>
                            {a.row.busy || a.flag === "capture_pending" || a.flag === "authorization_pending"
                              ? "Waiting for PayPal"
                              : "Open"}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Upcoming jobs</CardTitle>
              <CardDescription>Approved holds, next visit first</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
              {upcoming.length === 0 ? (
                <EmptyState icon={CalendarClock} title="No upcoming jobs">
                  Book one as the customer. It shows up here as soon as the hold is approved.
                </EmptyState>
              ) : (
                <ul className="-mx-2">
                  {upcoming.map((r) => (
                    <UpcomingJob key={r.id} row={r} onOpen={() => onOpenBooking(r.id)} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Recent activity</CardTitle>
            {state.ledger.length > activity.length ? (
              <Button variant="link" className="text-sm" onClick={onSeeAll}>
                See all
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="pt-3">
            {activity.length === 0 ? (
              <p className="text-[15px] text-muted-foreground">
                Nothing yet. PayPal steps show up here as they happen.
              </p>
            ) : (
              <ul className="space-y-3.5">
                {activity.map((a) => (
                  <li
                    key={a.id}
                    className="flex items-start gap-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300"
                  >
                    <LineIcon kind={a.kind} tone={a.tone} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] leading-snug">{a.text}</p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                        <span className="truncate">{[a.atLabel, a.sub].filter(Boolean).join(" · ")}</span>
                        {a.sample ? <SampleTag /> : null}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * The visitor's own booking, highlighted with the one primary action of this screen (docs/design-system.md):
 * Job done once the hold is approved, otherwise Open booking.
 */
function YourBooking({ row, onOpenBooking }: { row: Row; onOpenBooking: (id: string, action?: ActionKey) => void }) {
  const canFinish = row.status === "authorized" && row.actions.includes("job_done") && !row.busy;
  const hint = row.busy
    ? "PayPal is working on this… The page updates on its own."
    : row.flag
      ? (PAYMENT_FLAG[row.flag] ?? "Payment needs attention")
      : row.status === "pending_payment"
        ? "Waiting for the customer to approve the PayPal hold. Nothing is charged until you mark the job done."
        : `The ${row.hold} hold is approved. When the work is done, charge it — ${row.technician}'s payout goes out right after.`;
  return (
    <Card className="border-brand/25 bg-brand-soft/40" aria-label="Your booking">
      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div className="min-w-0 space-y-2">
          <Steps current={row.status === "authorized" ? 3 : 2} />
          <p className="pt-1 text-[13px] font-semibold tracking-wide text-brand uppercase">Your booking</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="truncate text-lg font-semibold tracking-tight">{row.serviceName}</p>
            <StatusPill status={row.status} flag={row.flag} />
          </div>
          <p className="text-sm text-muted-foreground">
            {row.day} · <span className="tabular-nums">{row.time}</span> · {row.technician} for {row.customer}
          </p>
          <p className={row.flag && !row.busy ? "text-sm text-danger" : "text-sm text-muted-foreground"}>{hint}</p>
        </div>
        <Button
          size="lg"
          className="w-full shrink-0 sm:w-auto"
          onClick={() => (canFinish ? onOpenBooking(row.id, "job_done") : onOpenBooking(row.id))}
        >
          {canFinish ? "Job done" : "Open booking"}
        </Button>
      </div>
    </Card>
  );
}

function UpcomingJob({ row, onOpen }: { row: Row; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-4 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-canvas focus-visible:ring-4 focus-visible:ring-brand/25 focus-visible:outline-none"
      >
        <span className="w-28 shrink-0 sm:w-40">
          <span className="block text-[15px] font-medium">{row.day}</span>
          <span className="block text-xs text-muted-foreground tabular-nums">{row.time}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px]">{row.serviceName}</span>
          <span className="block truncate text-sm text-muted-foreground">
            {row.technician} · for {row.customer}
          </span>
        </span>
        <span className="hidden shrink-0 sm:block">
          <StatusPill status={row.status} flag={row.flag} />
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}
