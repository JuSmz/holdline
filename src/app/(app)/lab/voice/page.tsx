import { and, desc, eq, inArray } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { VoiceLab } from "@/components/lab/voice-lab";
import { getDb } from "@/db/client";
import { calls, vapiEvents } from "@/db/schema";
import { readSecret, readVar } from "@/server/config/env";
import { labAccess } from "@/server/lab";
import { turnLatencyStats } from "@/server/vapi/messages";

export const metadata: Metadata = { title: "Voice lab", robots: { index: false, follow: false } };

type ToolResponsePayload = { results?: { error?: string }[] };

/** Stage-4 voice spike (PLAN stage 4). Exists only with LAB_ENABLED=true and an owner session. */
export default async function VoiceLabPage() {
  const access = await labAccess();
  if (access === "disabled") notFound();
  if (access === "login") redirect("/admin/login?next=/lab/voice");

  const missing = [
    readVar(process.env, "VAPI_PRIVATE_KEY") ? null : "VAPI_PRIVATE_KEY",
    readVar(process.env, "VAPI_PUBLIC_KEY") ? null : "VAPI_PUBLIC_KEY",
    readVar(process.env, "VAPI_ASSISTANT_ID") ? null : "VAPI_ASSISTANT_ID",
    readSecret(process.env, "VAPI_WEBHOOK_SECRET") ? null : "VAPI_WEBHOOK_SECRET (≥32 chars)",
  ].filter((m): m is string => m !== null);

  const db = getDb();
  const [recentCalls, events] = await Promise.all([
    db.select().from(calls).orderBy(desc(calls.createdAt)).limit(15),
    db
      .select({
        id: vapiEvents.id,
        receivedAt: vapiEvents.receivedAt,
        endpoint: vapiEvents.endpoint,
        messageType: vapiEvents.messageType,
        vapiCallId: vapiEvents.vapiCallId,
        callType: vapiEvents.callType,
      })
      .from(vapiEvents)
      .orderBy(desc(vapiEvents.receivedAt))
      .limit(40),
  ]);
  const callIds = recentCalls.map((c) => c.vapiCallId).filter((id): id is string => id !== null);
  const toolRows = callIds.length
    ? await db
        .select({ vapiCallId: vapiEvents.vapiCallId, payload: vapiEvents.payload })
        .from(vapiEvents)
        .where(and(inArray(vapiEvents.vapiCallId, callIds), eq(vapiEvents.messageType, "tool-calls.response")))
    : [];
  const tools = new Map<string, { ok: number; failed: number }>();
  for (const row of toolRows) {
    const payload = row.payload as ToolResponsePayload;
    if (!row.vapiCallId || !Array.isArray(payload?.results)) continue;
    const entry = tools.get(row.vapiCallId) ?? { ok: 0, failed: 0 };
    for (const r of payload.results) entry[r.error ? "failed" : "ok"] += 1;
    tools.set(row.vapiCallId, entry);
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-6 py-10">
      <header>
        <p className="text-sm font-medium text-brand">Owner lab · Vapi voice spike</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Voice lab</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Web calls go through <code>/api/vapi-proxy</code>; the server picks the assistant. Tool calls, status updates
          and end-of-call reports arrive at <code>/api/vapi/tools</code> and <code>/api/vapi/events</code> and are kept
          as fixtures.{" "}
          <a className="underline" href="/api/lab/voice/fixtures">
            Download fixtures (JSON)
          </a>
        </p>
      </header>

      {missing.length > 0 && (
        <p className="rounded-xl border p-4 text-sm">
          Not configured yet: <code>{missing.join(", ")}</code>
        </p>
      )}

      <VoiceLab ready={missing.length === 0} />

      <section>
        <h2 className="font-semibold">Calls</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {[
                  "Created",
                  "Type",
                  "Model",
                  "Status",
                  "Ended reason",
                  "Dur.",
                  "Cost",
                  "Turn p50/p95 (n)",
                  "Tools ok/failed",
                  "controlUrl",
                ].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentCalls.map((c) => {
                const turns = turnLatencyStats(c.metrics);
                const t = c.vapiCallId ? tools.get(c.vapiCallId) : undefined;
                return (
                  <tr key={c.id} className="border-t">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {c.createdAt.toISOString().slice(5, 19).replace("T", " ")}
                    </td>
                    <td className="px-3 py-2 font-mono">{c.vapiCallType ?? c.channel}</td>
                    <td className="px-3 py-2 font-mono">{c.llmModel ?? "–"}</td>
                    <td className="px-3 py-2">{c.status}</td>
                    <td className="px-3 py-2">{c.endedReason ?? "–"}</td>
                    <td className="px-3 py-2 font-mono">{c.durationS === null ? "–" : `${c.durationS}s`}</td>
                    <td className="px-3 py-2 font-mono">
                      {c.costCents === null ? "–" : `$${(c.costCents / 100).toFixed(2)}`}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {turns ? `${turns.p50} / ${turns.p95} ms (${turns.n})` : "–"}
                    </td>
                    <td className="px-3 py-2 font-mono">{t ? `${t.ok} / ${t.failed}` : "–"}</td>
                    <td className="px-3 py-2">{c.controlUrl ? "stored" : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="font-semibold">Vapi payloads (fixtures)</h2>
        <div className="mt-3 overflow-x-auto rounded-xl border">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {["Time", "Endpoint", "Type", "Call type", "Call id"].map((h) => (
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
                  <td className="px-3 py-2 font-mono">{e.endpoint}</td>
                  <td className="px-3 py-2 font-mono">{e.messageType}</td>
                  <td className="px-3 py-2 font-mono">{e.callType ?? "–"}</td>
                  <td className="px-3 py-2 font-mono">{e.vapiCallId?.slice(0, 13) ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
