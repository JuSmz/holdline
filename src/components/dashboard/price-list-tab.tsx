"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Pill } from "@/components/ui/status-pill";

import type { State } from "./shared";

/** Read-only: where every number the agent says comes from (SPEC §18 Price list & policies). */
export function PriceListTab({ catalog }: { catalog: State["catalog"] }) {
  const p = catalog.policy;
  const rules = [
    {
      label: "Free cancellation",
      value: `${p.cancellationWindowHours} h`,
      note: "before the visit; later costs the no-show fee",
    },
    { label: "Booking window", value: `${p.bookingWindowDays} days`, note: "how far ahead the agent books" },
    { label: "Time to approve", value: `${p.holdTtlMinutes} min`, note: "for the customer to approve the PayPal hold" },
    { label: "Technician share", value: p.technicianShare, note: "of every charge, paid out right after it" },
  ];
  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-[15px] text-muted-foreground">
        The AI receptionist quotes exactly these prices and rules. They come from this list in the database, never from
        the model, and every hold, fee and invoice is computed from them.
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {rules.map((r) => (
          <Card key={r.label} className="px-4 py-4 sm:px-5 sm:py-5">
            <p className="text-[13px] text-muted-foreground">{r.label}</p>
            <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{r.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{r.note}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Services</CardTitle>
          <CardDescription>The hold is the price; the no-show fee is charged from it when needed.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pt-3 pb-2 sm:px-0">
          <ul className="divide-y divide-border md:hidden">
            {catalog.services.map((s) => (
              <li key={s.key} className="px-5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[15px] font-medium">{s.name}</p>
                  <p className="font-medium tabular-nums">{s.price}</p>
                </div>
                <p className="text-sm text-muted-foreground">
                  {s.category} · {s.duration} · {s.noShowFee} no-show fee
                </p>
              </li>
            ))}
          </ul>
          <table className="hidden w-full text-[15px] md:table">
            <thead>
              <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                <th scope="col" className="py-2.5 pr-3 pl-6 font-medium">
                  Service
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  Category
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  Duration
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">
                  Price
                </th>
                <th scope="col" className="py-2.5 pr-6 pl-3 text-right font-medium">
                  No-show fee
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {catalog.services.map((s) => (
                <tr key={s.key}>
                  <td className="py-3 pr-3 pl-6">
                    <p className="flex items-center gap-2 font-medium">
                      {s.name}
                      {s.emergency ? <Pill tone="warning">Emergency</Pill> : null}
                    </p>
                    <p className="text-sm text-muted-foreground">{s.description}</p>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{s.category}</td>
                  <td className="px-3 py-3 text-muted-foreground">{s.duration}</td>
                  <td className="px-3 py-3 text-right font-medium tabular-nums">{s.price}</td>
                  <td className="py-3 pr-6 pl-3 text-right tabular-nums">{s.noShowFee}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Extra work</CardTitle>
            <CardDescription>The only lines an extra-work invoice can have (1–20 each).</CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            <ul className="divide-y divide-border">
              {catalog.addons.map((a) => (
                <li key={a.key} className="flex items-baseline justify-between gap-3 py-2.5">
                  <span className="text-[15px]">
                    {a.name} <span className="text-sm text-muted-foreground">per {a.unit}</span>
                  </span>
                  <span className="font-medium tabular-nums">{a.price}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Technicians</CardTitle>
            <CardDescription>Paid through PayPal Payouts after every charge.</CardDescription>
          </CardHeader>
          <CardContent className="pt-2">
            <ul className="divide-y divide-border">
              {catalog.technicians.map((t) => (
                <li key={t.name} className="flex items-baseline justify-between gap-3 py-2.5">
                  <span className="text-[15px]">
                    {t.name} <span className="text-sm text-muted-foreground">{t.skills}</span>
                  </span>
                  <span className="text-sm text-muted-foreground tabular-nums">{t.share} share</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
