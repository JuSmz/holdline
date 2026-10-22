"use client";

import { cn } from "cn";
import { CalendarX2, ChevronRight } from "lucide-react";
import { useState } from "react";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PAYMENT_FLAG, StatusPill } from "@/components/ui/status-pill";

import { AmountCell, type Row, SampleTag } from "./shared";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "attention", label: "Needs attention" },
  { key: "closed", label: "Closed" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

const CLOSED = new Set(["captured", "paid_out", "voided", "expired"]);
const needsAttention = (r: Row) => !r.sample && (Boolean(r.flag) || (r.status === "authorized" && r.past));

function matches(r: Row, filter: Filter) {
  if (filter === "all") return true;
  if (filter === "attention") return needsAttention(r);
  if (filter === "closed") return CLOSED.has(r.status) && !r.flag;
  return !CLOSED.has(r.status) || Boolean(r.flag);
}

/** The flag as a short red line under the service (docs/design-system.md: a red dot plus a short line). */
function FlagLine({ flag }: { flag: string | null }) {
  if (!flag) return null;
  return <p className="text-sm text-danger">{PAYMENT_FLAG[flag] ?? "Payment needs attention"}</p>;
}

/** Cards on phones, a clean table on desktop; a row opens the booking sheet. IDs only in the sheet. */
export function BookingsTab({ rows, onOpen }: { rows: Row[]; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = rows.filter((r) => matches(r, filter));
  return (
    <div className="space-y-4">
      <div className="-mx-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-4 sm:mx-0 sm:px-0">
        <div className="inline-flex gap-1.5" role="group" aria-label="Filter bookings">
          {FILTERS.map((f) => {
            const count = rows.filter((r) => matches(r, f.key)).length;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  "h-8 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:ring-4 focus-visible:ring-brand/25 focus-visible:outline-none",
                  filter === f.key
                    ? "bg-foreground text-background"
                    : "bg-card text-muted-foreground shadow-sm hover:text-foreground",
                )}
              >
                {f.label}
                {f.key !== "all" && count > 0 ? <span className="ml-1.5 tabular-nums opacity-70">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {shown.length === 0 ? (
        <Card>
          <EmptyState icon={CalendarX2} title={filter === "all" ? "No bookings yet" : "Nothing here"}>
            {filter === "all"
              ? "Book a job as the customer. It appears here the moment the agent creates it."
              : "No bookings match this filter."}
          </EmptyState>
        </Card>
      ) : (
        <>
          {/* Phones: cards */}
          <ul className="space-y-2.5 md:hidden">
            {shown.map((r) => (
              <li key={r.id} data-testid={`booking-card-${r.ref}`}>
                <button
                  type="button"
                  onClick={() => onOpen(r.id)}
                  className="w-full rounded-2xl border border-border bg-card p-4 text-left shadow-card transition-transform focus-visible:ring-4 focus-visible:ring-brand/25 focus-visible:outline-none active:scale-[0.99]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-semibold">{r.serviceName}</p>
                      <p className="text-sm text-muted-foreground">
                        {r.day} · <span className="tabular-nums">{r.time}</span>
                      </p>
                      <FlagLine flag={r.flag} />
                    </div>
                    <StatusPill status={r.status} flag={r.flag} />
                  </div>
                  <div className="mt-3 flex items-end justify-between gap-3">
                    <div className="min-w-0 text-sm text-muted-foreground">
                      <p className="truncate">
                        {r.customer} · {r.technician}
                      </p>
                      {r.sample ? (
                        <p className="mt-1">
                          <SampleTag />
                        </p>
                      ) : null}
                    </div>
                    <AmountCell row={r} />
                  </div>
                </button>
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <Card className="hidden overflow-hidden md:block">
            <table className="w-full text-[15px]">
              <thead>
                <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                  <th scope="col" className="py-3 pr-3 pl-6 font-medium">
                    Booking
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    When
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Customer
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Technician
                  </th>
                  <th scope="col" className="px-3 py-3 text-right font-medium">
                    Amount
                  </th>
                  <th scope="col" className="py-3 pr-6 pl-3 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.map((r) => (
                  <tr
                    key={r.id}
                    data-testid={`booking-${r.ref}`}
                    onClick={() => onOpen(r.id)}
                    className="cursor-pointer transition-colors hover:bg-canvas"
                  >
                    <td className="py-3 pr-3 pl-6">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(r.id);
                        }}
                        className="text-left font-medium focus-visible:underline focus-visible:outline-none"
                      >
                        {r.serviceName}
                      </button>
                      <FlagLine flag={r.flag} />
                      {r.sample ? (
                        <p className="mt-0.5">
                          <SampleTag />
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      <p>{r.day}</p>
                      <p className="text-sm text-muted-foreground tabular-nums">{r.time}</p>
                    </td>
                    <td className="px-3 py-3">{r.customer}</td>
                    <td className="px-3 py-3">{r.technician}</td>
                    <td className="px-3 py-3">
                      <AmountCell row={r} />
                    </td>
                    <td className="py-3 pr-6 pl-3">
                      <div className="flex items-center justify-between gap-2">
                        <span data-testid="status">
                          <StatusPill status={r.status} flag={r.flag} />
                        </span>
                        <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
