"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { DashboardData } from "@/server/dashboard/queries";

const ACTIONS = [
  { action: "job_done", label: "Job done", confirm: (b: Row) => `Capture ${b.amount} for ${b.ref}?` },
  {
    action: "no_show",
    label: "No-show",
    confirm: (b: Row) => `Charge the ${b.noShowFee} no-show fee for ${b.ref}? The rest of the hold is released.`,
  },
  {
    action: "cancel",
    label: "Cancel",
    confirm: (b: Row, late: boolean) =>
      late
        ? `Late cancellation (less than ${b.cancelWindowHours} hours before the visit): the ${b.noShowFee} fee will be charged for ${b.ref}. Continue?`
        : `Free cancellation: the ${b.amount} hold for ${b.ref} is released and nothing is charged. Continue?`,
  },
] as const;

type Row = DashboardData["bookings"][number];

/** The late-cancellation rule at the moment of the click (the server checks the same rule). */
const isLate = (b: Row) => new Date(b.slotStart).getTime() - Date.now() < b.cancelWindowHours * 3_600_000;

/** The minimal owner page (stage 7): bookings with their actions, the PayPal activity feed, the outbox. */
export function OwnerDashboard({ data }: { data: DashboardData }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  async function act(row: Row, action: (typeof ACTIONS)[number]) {
    // The rule the owner sees is the rule the server is asked to apply (it refuses if that changed).
    const late = isLate(row);
    if (!window.confirm(action.confirm(row, late))) return;
    setBusy(row.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/dashboard/bookings/${row.id}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action.action === "cancel" ? { action: action.action, expectLate: late } : { action: action.action },
        ),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      setMessage(
        data?.ok
          ? `${row.ref}: ${String(data.bookingStatus)}${data.flag ? ` (${String(data.flag)})` : ""}`
          : `${row.ref}: ${String(data?.message ?? "failed")}`,
      );
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  return (
    <div className="space-y-8">
      {message ? (
        <p className="rounded-lg border px-3 py-2 text-sm" role="status">
          {message}
        </p>
      ) : null}
      <section>
        <h2 className="text-lg font-semibold">Bookings</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left">
              <tr>
                <th className="px-3 py-2">Ref</th>
                <th className="px-3 py-2">Service</th>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Customer</th>
                <th className="px-3 py-2">Amount</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.bookings.map((b) => (
                <tr key={b.id} className="border-t" data-testid={`booking-${b.ref}`}>
                  <td className="px-3 py-2 font-mono">
                    {b.ref}
                    {b.sample ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">Sample</span> : null}
                  </td>
                  <td className="px-3 py-2">{b.serviceName}</td>
                  <td className="px-3 py-2">{b.appointment}</td>
                  <td className="px-3 py-2">{b.customerFirstName}</td>
                  <td className="px-3 py-2">{b.amount}</td>
                  <td className="px-3 py-2" data-testid="status">
                    {b.status}
                    {b.flag ? <span className="ml-1 text-xs text-destructive">({b.flag})</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    {!b.sample && b.status === "authorized" ? (
                      <div className="flex gap-1">
                        {ACTIONS.map((a) => (
                          <Button
                            key={a.action}
                            size="xs"
                            variant="outline"
                            disabled={busy === b.id}
                            onClick={() => act(b, a)}
                          >
                            {a.label}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="text-lg font-semibold">PayPal activity</h2>
          <ul className="mt-3 space-y-1 rounded-xl border p-3 text-sm">
            {data.activity.length === 0 ? <li className="text-muted-foreground">Nothing yet.</li> : null}
            {data.activity.map((a, i) => (
              <li key={`${a.at}-${i}`} className="flex gap-2">
                <span className="shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">
                  {new Date(a.at).toLocaleTimeString()}
                </span>
                <span className="font-mono">{a.ref}</span>
                <span className={a.source === "paypal" ? "text-brand" : ""}>{a.text}</span>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2 className="text-lg font-semibold">Outbox</h2>
          <p className="text-sm text-muted-foreground">Emails the system would send. In this demo they stay here.</p>
          <ul className="mt-3 space-y-1 rounded-xl border p-3 text-sm">
            {data.outbox.length === 0 ? <li className="text-muted-foreground">No emails yet.</li> : null}
            {data.outbox.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className="text-left hover:underline"
                  onClick={() => setPreview(preview === m.id ? null : m.id)}
                >
                  <span className="font-mono">{m.ref}</span> {m.subject}{" "}
                  <span className="text-muted-foreground">({m.status})</span>
                </button>
                {preview === m.id ? (
                  <iframe
                    title={m.subject}
                    // No scripts, no same-origin; links may open a new tab (the pay page runs there).
                    sandbox="allow-popups allow-popups-to-escape-sandbox"
                    srcDoc={m.html}
                    className="mt-2 h-80 w-full rounded border bg-white"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
