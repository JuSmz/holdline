"use client";

import { cn } from "cn";
import { Wallet } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

import { LineIcon, SampleTag, type State, TONE_TEXT } from "./shared";

/** One ledger of holds, charges, releases, invoices and payouts, plus what each technician got. */
export function PaymentsTab({ state, onOpenBooking }: { state: State; onOpenBooking: (id: string) => void }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {state.payoutTotals.map((t) => (
          <Card key={t.name} className="px-5 py-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[15px] font-semibold">{t.name}</p>
              <p className="text-xs text-muted-foreground">{t.share} share</p>
            </div>
            <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{t.paid}</p>
            <p className="text-sm text-muted-foreground">
              Paid out · {t.paidCount} {t.paidCount === 1 ? "payout" : "payouts"}
            </p>
            {t.onTheWay ? <p className="mt-1 text-sm text-brand tabular-nums">{t.onTheWay} on the way</p> : null}
            {t.failed > 0 ? (
              <p className="mt-1 text-sm text-danger">{t.failed} failed — retry from the booking</p>
            ) : null}
            {t.sample ? <p className="mt-1 text-xs text-muted-foreground/80">{t.sample}</p> : null}
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ledger</CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {state.ledger.length === 0 ? (
            <EmptyState icon={Wallet} title="No money has moved yet">
              Holds, charges and payouts show up here the moment PayPal confirms them.
            </EmptyState>
          ) : (
            <ul className="-mx-2 divide-y divide-border">
              {state.ledger.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => onOpenBooking(e.bookingId)}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-canvas focus-visible:ring-4 focus-visible:ring-brand/25 focus-visible:outline-none"
                  >
                    <LineIcon kind={e.kind} tone={e.tone} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium">{e.title}</span>
                      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <span className="truncate">
                          {e.sub} · {e.atLabel}
                        </span>
                        {e.sample ? <SampleTag /> : null}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span
                        className={cn(
                          "block font-medium tabular-nums",
                          e.sign === "+" && "text-success",
                          e.sign === "" && "text-muted-foreground",
                        )}
                      >
                        {e.sign}
                        {e.amount}
                      </span>
                      <span className={cn("block text-xs", TONE_TEXT[e.status.tone])}>{e.status.label}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
