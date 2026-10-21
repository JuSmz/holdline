"use client";

import type Vapi from "@vapi-ai/web";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "starting" | "stopping" | "live" | "ended";
type Line = { id: number; role: string; text: string };
type Notice = "authorized" | "declined_retry" | "expired";
type Measurement = {
  id: string;
  notice: Notice;
  ok: boolean | null;
  serverMs: number | null;
  sayMs: number | null;
  addMessage: string | null;
  speechMs: number | null;
  source: string | null;
  error: string | null;
};
type ControlOutcome = { ok: boolean; ms: number; status: number | null; error?: string };
type NotifyResponse = {
  ok?: boolean;
  totalMs?: number;
  controlUrlSource?: string;
  say?: ControlOutcome | null;
  addMessage?: ControlOutcome | null;
  error?: string;
};
type VapiMessage = {
  type?: string;
  role?: string;
  transcriptType?: string;
  transcript?: string;
  status?: string;
  endedReason?: string;
};

const NOTICES: { notice: Notice; label: string }[] = [
  { notice: "authorized", label: "Simulate: authorized" },
  { notice: "declined_retry", label: "Simulate: declined" },
  { notice: "expired", label: "Simulate: expired" },
];

const seconds = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** Remote audio counts as speech above the SDK's own threshold (audio level 0.01, emitted as level / 0.15). */
const AUDIBLE = 0.01 / 0.15;
/** A notice is only measured after this much agent silence, so its audio can't be confused with a reply. */
const QUIET_BEFORE_NOTICE_MS = 1000;

/** Detaches the UI, keeps an error sink (the SDK's emitter throws on "error" without a listener), leaves the room. */
async function teardown(vapi: Vapi) {
  vapi.removeAllListeners();
  vapi.on("error", () => {});
  await vapi.stop().catch(() => {});
}

export function VoiceLab({ ready }: { ready: boolean }) {
  const router = useRouter();
  const vapiRef = useRef<Vapi | null>(null);
  // Bumped by every start, by End call while starting, and on unmount: a stale start tears itself down.
  const attempt = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ id: string; t0: number; expiry: ReturnType<typeof setTimeout> } | null>(null);
  const lastAudibleAt = useRef(Number.NEGATIVE_INFINITY);
  const warnedControlUrl = useRef(false);
  const lineId = useRef(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [callId, setCallId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [lastUserAt, setLastUserAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [noticeBusy, setNoticeBusy] = useState(false);

  const addLog = (text: string) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} ${text}`, ...prev].slice(0, 60));

  useEffect(() => {
    if (phase !== "live") return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [phase]);

  // Leaving the page ends the call, including one that is still starting (it is billed from the join).
  useEffect(
    () => () => {
      attempt.current += 1;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (pending.current) clearTimeout(pending.current.expiry);
      pending.current = null;
      const vapi = vapiRef.current;
      vapiRef.current = null;
      if (vapi) void teardown(vapi);
    },
    [],
  );

  function clearPending(id?: string) {
    const p = pending.current;
    if (!p || (id && p.id !== id)) return;
    clearTimeout(p.expiry);
    pending.current = null;
    setNoticeBusy(false);
  }

  async function start() {
    const mine = ++attempt.current;
    const stale = () => attempt.current !== mine;
    setPhase("starting");
    setLines([]);
    setMeasurements([]);
    setCallId(null);
    setMuted(false);
    clearPending();
    let vapi: Vapi | null = null;
    try {
      const { default: VapiClient } = await import("@vapi-ai/web");
      if (stale()) return;
      // The base URL points at our proxy; "proxy" is a placeholder token the proxy ignores (SPEC §14.3).
      vapi = new VapiClient("proxy", `${window.location.origin}/api/vapi-proxy`);
      vapiRef.current = vapi;

      vapi.on("call-start", () => {
        setPhase("live");
        setStartedAt(Date.now());
        setLastUserAt(Date.now());
        addLog("call-start");
      });
      vapi.on("call-end", () => {
        setPhase("ended");
        clearPending();
        addLog("call-end");
        refreshTimer.current = setTimeout(() => router.refresh(), 4000);
      });
      // R15: the first agent audio after a notice click. Measured on the level itself, because the SDK's
      // speech-start fires only after a full second of silence.
      vapi.on("volume-level", (level: number) => {
        setVolume(level);
        if (level <= AUDIBLE) return;
        const t = performance.now();
        lastAudibleAt.current = t;
        const p = pending.current;
        if (!p || t <= p.t0) return;
        clearPending(p.id);
        setMeasurements((prev) => prev.map((m) => (m.id === p.id ? { ...m, speechMs: Math.round(t - p.t0) } : m)));
      });
      vapi.on("message", (raw: unknown) => {
        const m = raw as VapiMessage;
        // Spike check: the controlUrl must stay server-side; report if a client message carries one.
        if (!warnedControlUrl.current && JSON.stringify(raw).includes("controlUrl")) {
          warnedControlUrl.current = true;
          addLog(`WARNING: client message "${m.type ?? "?"}" carries a controlUrl`);
        }
        if (m.type === "transcript" && m.transcriptType === "final" && m.transcript) {
          lineId.current += 1;
          const line = { id: lineId.current, role: m.role ?? "?", text: m.transcript };
          setLines((prev) => [...prev, line].slice(-80));
          if (m.role === "user") setLastUserAt(Date.now());
        } else if (m.type === "speech-update" && m.role === "user") {
          setLastUserAt(Date.now());
        } else if (m.type === "status-update") {
          addLog(`status ${m.status ?? "?"}${m.endedReason ? ` (${m.endedReason})` : ""}`);
        }
      });
      vapi.on("error", (e: unknown) => addLog(`error ${JSON.stringify(e).slice(0, 400)}`));
      vapi.on("call-start-failed", (e: unknown) => addLog(`call-start-failed ${JSON.stringify(e).slice(0, 400)}`));

      // Any assistant value works: the proxy discards the body and picks the assistant itself.
      const call = await vapi.start("server-selected");
      if (stale()) return;
      setCallId(call?.id ?? null);
      addLog(`call created ${call?.id ?? "(none)"}`);
      if (!call) setPhase("idle");
    } catch (error) {
      if (stale()) return;
      addLog(`start failed: ${error instanceof Error ? error.message : String(error)}`);
      setPhase("idle");
    } finally {
      if (stale()) {
        // Ended or left while starting. The room may exist only now, so stop() really tears it down;
        // Start stays disabled ("stopping") until it is gone.
        if (vapi) {
          if (vapiRef.current === vapi) vapiRef.current = null;
          await teardown(vapi);
        }
        setPhase((p) => (p === "stopping" ? "idle" : p));
      }
    }
  }

  async function end() {
    const vapi = vapiRef.current;
    if (phase === "starting") {
      attempt.current += 1; // the in-flight start tears down in its finally
      setPhase("stopping");
      if (vapi) void vapi.stop(); // leaves at once if the join has begun
      return;
    }
    if (vapi) await vapi.stop();
    else setPhase("idle"); // the instance is already gone (e.g. dev Fast Refresh ran the cleanup)
  }

  function toggleMute() {
    const vapi = vapiRef.current;
    if (!vapi) return;
    const next = !vapi.isMuted();
    vapi.setMuted(next);
    setMuted(next);
  }

  /** `clickedAt` is the click event's timeStamp: the same clock as performance.now(). */
  async function simulate(notice: Notice, clickedAt: number) {
    if (!callId || pending.current) return;
    if (clickedAt - lastAudibleAt.current < QUIET_BEFORE_NOTICE_MS) {
      addLog("notice not sent: the agent was audible in the last second; press again once it is silent");
      return;
    }
    const id = crypto.randomUUID();
    // A reply more than 10 s later is a normal turn, not this notice's speech.
    pending.current = { id, t0: clickedAt, expiry: setTimeout(() => clearPending(id), 10_000) };
    setNoticeBusy(true);
    setMeasurements((prev) => [
      {
        id,
        notice,
        ok: null,
        serverMs: null,
        sayMs: null,
        addMessage: null,
        speechMs: null,
        source: null,
        error: null,
      },
      ...prev,
    ]);
    let data: NotifyResponse;
    try {
      const res = await fetch("/api/lab/voice/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId, notice }),
      });
      data = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as NotifyResponse;
    } catch (error) {
      data = { ok: false, error: error instanceof Error ? error.message : "network error" };
    }
    if (!data.say?.ok) clearPending(id);
    const add = data.addMessage;
    setMeasurements((prev) =>
      prev.map((m) =>
        m.id === id
          ? {
              ...m,
              ok: Boolean(data.ok),
              serverMs: data.totalMs ?? null,
              sayMs: data.say?.ms ?? null,
              addMessage: add ? (add.ok ? `ok ${add.ms} ms` : (add.error ?? `HTTP ${add.status}`)) : "not sent",
              source: data.controlUrlSource ?? null,
              error: data.error ?? data.say?.error ?? (data.say && !data.say.ok ? `HTTP ${data.say.status}` : null),
            }
          : m,
      ),
    );
  }

  const live = phase === "live";
  const button = "h-9 rounded-lg border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50";

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-xl border p-6">
        <h2 className="font-semibold">1 · Web call through the proxy</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Each call costs Vapi credit. Start it only after the cost estimate has been confirmed in chat.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={button}
            disabled={!ready || phase === "starting" || phase === "stopping" || live}
            onClick={() => void start()}
          >
            Start call
          </button>
          <button type="button" className={button} disabled={!live && phase !== "starting"} onClick={() => void end()}>
            End call
          </button>
          <button type="button" className={button} disabled={!live} onClick={toggleMute}>
            {muted ? "Unmute" : "Mute"}
          </button>
          <span className="text-sm text-muted-foreground">{phase}</span>
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Duration</dt>
            <dd className="font-mono">{startedAt && live ? seconds(now - startedAt) : "–"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Since caller spoke</dt>
            <dd className="font-mono">{lastUserAt && live ? seconds(now - lastUserAt) : "–"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Assistant volume</dt>
            <dd className="mt-2 h-2 rounded bg-muted">
              <div className="h-2 rounded bg-brand" style={{ width: `${Math.round(volume * 100)}%` }} />
            </dd>
          </div>
        </dl>
        <p className="mt-3 font-mono text-xs break-all text-muted-foreground">call id: {callId ?? "–"}</p>
        <ol className="mt-4 max-h-80 space-y-1 overflow-y-auto text-sm">
          {lines.map((l) => (
            <li key={l.id}>
              <span className="font-medium">{l.role === "assistant" ? "Agent" : "You"}:</span> {l.text}
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-xl border p-6">
        <h2 className="font-semibold">2 · Mid-call payment notice</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sends the fixed sentence with <code>say</code>, then <code>add-message</code>, through the call&apos;s
          controlUrl. Press it after the agent has been silent for at least a second: &quot;Click → speech&quot; is the
          time until its audio starts.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {NOTICES.map(({ notice, label }) => (
            <button
              key={notice}
              type="button"
              className={button}
              disabled={!live || noticeBusy}
              onClick={(e) => void simulate(notice, e.timeStamp)}
            >
              {label}
            </button>
          ))}
        </div>
        <table className="mt-4 w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              {["Notice", "OK", "Server ms", "say ms", "add-message", "Click → speech", "controlUrl", "Error"].map(
                (h) => (
                  <th key={h} className="py-1 pr-2 font-medium">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {measurements.map((m) => (
              <tr key={m.id} className="border-t">
                <td className="py-1 pr-2">{m.notice}</td>
                <td className="py-1 pr-2">{m.ok === null ? "…" : m.ok ? "yes" : "no"}</td>
                <td className="py-1 pr-2 font-mono">{m.serverMs ?? "–"}</td>
                <td className="py-1 pr-2 font-mono">{m.sayMs ?? "–"}</td>
                <td className="py-1 pr-2">{m.addMessage ?? "–"}</td>
                <td className="py-1 pr-2 font-mono">{m.speechMs === null ? "–" : `${m.speechMs} ms`}</td>
                <td className="py-1 pr-2">{m.source ?? "–"}</td>
                <td className="py-1 pr-2">{m.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="mt-6 text-sm font-medium">SDK events</h3>
        <ol className="mt-2 max-h-56 space-y-0.5 overflow-y-auto font-mono text-xs text-muted-foreground">
          {log.map((entry, i) => (
            <li key={`${i}-${entry}`}>{entry}</li>
          ))}
        </ol>
      </section>
    </div>
  );
}
