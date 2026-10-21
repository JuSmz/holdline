import { desc, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { PayPalLab } from "@/components/lab/paypal-lab";
import { getDb } from "@/db/client";
import { paypalApiLog, webhookEvents } from "@/db/schema";
import { readVar } from "@/server/config/env";
import { labAccess } from "@/server/lab";

export const metadata: Metadata = { title: "PayPal lab", robots: { index: false, follow: false } };

/** Stage-2 sandbox lab (PLAN stage 2). Exists only with LAB_ENABLED=true and an owner session. */
export default async function PayPalLabPage() {
  const access = await labAccess();
  if (access === "disabled") notFound();
  if (access === "login") redirect("/admin/login?next=/lab/paypal");

  const clientId = readVar(process.env, "PAYPAL_CLIENT_ID");
  const db = getDb();
  const [calls, events, authRows] = await Promise.all([
    db.select().from(paypalApiLog).orderBy(desc(paypalApiLog.at)).limit(25),
    db.select().from(webhookEvents).orderBy(desc(webhookEvents.receivedAt)).limit(25),
    db
      .select({ op: paypalApiLog.op, ids: paypalApiLog.resourceIds, status: paypalApiLog.resourceStatus })
      .from(paypalApiLog)
      .where(inArray(paypalApiLog.op, ["orders.authorize", "payments.authorization.get"]))
      .orderBy(desc(paypalApiLog.at))
      .limit(200),
  ]);
  // Last known status per authorization: newest GET, else the status returned by authorize.
  const latest = new Map<string, string>();
  for (const row of authRows) {
    const id = row.ids.authorizationId;
    if (!id || latest.has(id)) continue;
    const status = row.op === "payments.authorization.get" ? row.status : row.ids.authorizationStatus;
    if (status) latest.set(id, status);
  }
  const recentAuthorizations = [...latest.entries()]
    .filter(([, status]) => status !== "CAPTURED" && status !== "VOIDED")
    .slice(0, 20)
    .map(([id, status]) => ({ id, status }));

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-6 py-10">
      <header>
        <p className="text-sm font-medium text-brand">Owner lab · PayPal sandbox</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">PayPal lab</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Exercises Orders v2 (AUTHORIZE) and Payments v2 (capture, partial capture with final_capture, void,
          reauthorize) against the sandbox. Every call is logged below; verified webhooks appear as PayPal sends them.
        </p>
      </header>

      {clientId ? (
        <PayPalLab clientId={clientId} recentAuthorizations={recentAuthorizations} />
      ) : (
        <p className="rounded-xl border p-6 text-sm">
          <code>PAYPAL_CLIENT_ID</code> is not set.
        </p>
      )}

      <section>
        <h2 className="font-semibold">PayPal API calls</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {["Time", "Operation", "HTTP", "Status / issue", "IDs", "debug_id", "Tries", "ms"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="px-3 py-2 whitespace-nowrap">{c.at.toISOString().slice(11, 19)}</td>
                  <td className="px-3 py-2 font-mono">{c.op}</td>
                  <td className="px-3 py-2">{c.httpStatus ?? "—"}</td>
                  <td className="px-3 py-2">{c.issue ?? c.resourceStatus ?? ""}</td>
                  <td className="px-3 py-2 font-mono">{Object.values(c.resourceIds).join(" · ")}</td>
                  <td className="px-3 py-2 font-mono">{c.debugId ?? ""}</td>
                  <td className="px-3 py-2">{c.attempts}</td>
                  <td className="px-3 py-2">{c.durationMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="font-semibold">Verified webhooks</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {["Received", "Event", "Resource", "Via", "Simulated"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="px-3 py-2 whitespace-nowrap">{e.receivedAt.toISOString().slice(11, 19)}</td>
                  <td className="px-3 py-2 font-mono">{e.eventType}</td>
                  <td className="px-3 py-2 font-mono">{e.resourceId ?? ""}</td>
                  <td className="px-3 py-2">{e.verifiedVia}</td>
                  <td className="px-3 py-2">{e.simulated ? "yes" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
