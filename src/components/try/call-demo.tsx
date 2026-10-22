"use client";

import type Vapi from "@vapi-ai/web";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { type PanelBooking, PayPanel } from "./pay-panel";

type Phase = "form" | "checking" | "starting" | "live" | "ended";
type Line = { id: number; role: string; text: string };
type State = {
  booking: (PanelBooking & { status: string }) | null;
  buyer: { email: string; password: string } | null;
  notify: { status: string; ok: boolean | null; via: string | null; fallback: boolean } | null;
};
type VapiMessage = { type?: string; role?: string; transcript?: string; transcriptType?: string };

const POLL_MS = 1500;
/** Without any server notice this long after authorized, the page speaks the confirmation itself. */
const FALLBACK_AFTER_MS = 4000;

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/**
 * /try/call (SPEC §16): the browser call through our proxy, the live transcript, and the pay panel on
 * the same screen. The confirmation is spoken by the server (`say`); the page speaks it only as the
 * documented fallback.
 */
export function CallDemo({
  defaults,
  clientId,
  mocked,
}: {
  defaults: { firstName: string; email: string };
  clientId: string | null;
  mocked: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("form");
  const [form, setForm] = useState(defaults);
  const [error, setError] = useState<{ text: string; offerChat: boolean } | null>(null);
  const [vapiCallId, setVapiCallId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0);
  const [state, setState] = useState<State | null>(null);
  const vapiRef = useRef<Vapi | null>(null);
  const lineId = useRef(0);
  // Per booking: when it was first seen authorized, and whether the page already spoke for it.
  const fallback = useRef<{ bookingId: string; seenAt: number; inFlight: boolean; done: boolean } | null>(null);
  // Set by End or by leaving the page while the call is still being created (stop() can't reach it yet).
  const cancelled = useRef(false);

  const poll = useCallback(async () => {
    if (!vapiCallId) return;
    const res = await fetch(`/api/try/state?vapi=${encodeURIComponent(vapiCallId)}`, { cache: "no-store" });
    if (res.ok) setState((await res.json()) as State);
  }, [vapiCallId]);

  useEffect(() => {
    if (!vapiCallId) return;
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [vapiCallId, poll]);

  // Browser fallback (§16.7): only when the server says the page may speak (a definite failure or a
  // claim that never settled), or no notice row appeared in time. Retried on later polls until spoken.
  useEffect(() => {
    const booking = state?.booking;
    if (phase !== "live" || !booking || booking.panel !== "authorized") return;
    if (fallback.current?.bookingId !== booking.id) {
      fallback.current = { bookingId: booking.id, seenAt: Date.now(), inFlight: false, done: false };
    }
    const f = fallback.current;
    if (f.inFlight || f.done) return;
    const allowed = state?.notify ? state.notify.fallback : Date.now() - f.seenAt > FALLBACK_AFTER_MS;
    if (!allowed) return;
    f.inFlight = true;
    post("/api/try/notify-fallback", { bookingId: booking.id })
      .then(({ data }) => {
        if (typeof data?.say !== "string") return;
        vapiRef.current?.say(data.say, false, false, false);
        f.done = true;
      })
      .catch(() => {})
      .finally(() => {
        f.inFlight = false;
      });
  }, [state, phase]);

  useEffect(
    () => () => {
      cancelled.current = true;
      const vapi = vapiRef.current;
      if (vapi) {
        vapi.removeAllListeners();
        void vapi.stop().catch(() => {});
      }
    },
    [],
  );

  async function start(event: React.FormEvent) {
    event.preventDefault();
    cancelled.current = false; // set again by End or by leaving the page, checked after every await
    setError(null);
    setPhase("checking");
    // Mic preflight: ask once, release at once; the SDK asks again when it joins.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      if (cancelled.current) return;
    } catch {
      setError({
        text: "The microphone is blocked or missing. You can allow it in the browser, or use the chat.",
        offerChat: true,
      });
      setPhase("form");
      return;
    }
    const intent = await post("/api/try/call/intent", form);
    if (!intent.data?.ok) {
      setError({ text: String(intent.data?.message ?? "Couldn't start the call."), offerChat: intent.status === 429 });
      setPhase("form");
      return;
    }

    if (cancelled.current) return;
    setPhase("starting");
    try {
      const { default: VapiClient } = await import("@vapi-ai/web");
      if (cancelled.current) return;
      // "proxy" is a placeholder: the proxy ignores the body and picks the assistant (SPEC §14.3).
      const vapi = new VapiClient("proxy", `${window.location.origin}/api/vapi-proxy`);
      vapiRef.current = vapi;
      vapi.on("call-start", () => {
        if (!cancelled.current) setPhase("live");
      });
      vapi.on("call-end", () => {
        setPhase("ended");
        setVolume(0);
      });
      vapi.on("volume-level", (level: number) => setVolume(level));
      vapi.on("message", (raw: unknown) => {
        const m = raw as VapiMessage;
        if (m.type === "transcript" && m.transcriptType === "final" && m.transcript) {
          lineId.current += 1;
          const line = { id: lineId.current, role: m.role ?? "?", text: m.transcript };
          setLines((prev) => [...prev, line].slice(-60));
        }
      });
      vapi.on("call-start-failed", () => {
        if (cancelled.current) return; // the customer pressed End while connecting
        setError({ text: "Voice line busy — the chat uses the same agent and payment flow.", offerChat: true });
        setPhase("form");
      });
      vapi.on("error", () => {});
      const call = await vapi.start("server-selected");
      if (cancelled.current) {
        // Ended (or left) while connecting: the room exists only now, so this stop() really ends it.
        await vapi.stop().catch(() => {});
        return;
      }
      if (!call) {
        setError({ text: "Voice line busy — the chat uses the same agent and payment flow.", offerChat: true });
        setPhase("form");
        return;
      }
      setVapiCallId(call.id);
    } catch {
      if (cancelled.current) return;
      setError({ text: "Couldn't connect the call. Please try again, or use the chat.", offerChat: true });
      setPhase("form");
    }
  }

  async function end() {
    if (phase === "starting") cancelled.current = true; // the pending start() stops the call once it exists
    await vapiRef.current?.stop().catch(() => {});
    setPhase("ended");
  }

  if (phase === "form" || phase === "checking") {
    return (
      <form onSubmit={start} className="max-w-md space-y-4 rounded-xl border p-6">
        <p className="text-sm text-muted-foreground">
          The agent uses the name and email from this form. Calls are transcribed; please use made-up details. On a
          phone, a second device for the PayPal step works best.
        </p>
        <label className="block text-sm font-medium">
          First name
          <input
            className="mt-1 w-full rounded-lg border bg-background px-3 py-2"
            value={form.firstName}
            maxLength={40}
            required
            onChange={(e) => setForm({ ...form, firstName: e.target.value })}
          />
        </label>
        <label className="block text-sm font-medium">
          Email
          <input
            className="mt-1 w-full rounded-lg border bg-background px-3 py-2"
            type="email"
            value={form.email}
            maxLength={120}
            required
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        {error ? (
          <p className="text-sm text-destructive">
            {error.text}{" "}
            {error.offerChat ? (
              <Link className="underline" href="/try/chat">
                Open the chat
              </Link>
            ) : null}
          </p>
        ) : null}
        <Button type="submit" size="lg" disabled={phase === "checking"}>
          <Mic /> {phase === "checking" ? "Checking the microphone…" : "Start the call"}
        </Button>
      </form>
    );
  }

  const booking = state?.booking ?? null;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="flex min-h-[460px] flex-col rounded-xl border" aria-label="Call">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-medium" aria-live="polite">
            {phase === "starting" ? "Connecting…" : phase === "live" ? "On the call" : "Call ended"}
          </p>
          <div className="flex items-center gap-2">
            <span className="h-2 w-16 overflow-hidden rounded bg-muted" aria-hidden>
              <span
                className="block h-full bg-brand transition-[width]"
                style={{ width: `${Math.min(100, volume * 300)}%` }}
              />
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={phase !== "live"}
              onClick={() => {
                const next = !muted;
                vapiRef.current?.setMuted(next);
                setMuted(next);
              }}
            >
              {muted ? <MicOff /> : <Mic />} {muted ? "Unmute" : "Mute"}
            </Button>
            <Button variant="destructive" size="sm" disabled={phase === "ended"} onClick={() => void end()}>
              <PhoneOff /> End
            </Button>
          </div>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-4 text-sm">
          {lines.length === 0 ? <p className="text-muted-foreground">The transcript appears here.</p> : null}
          {lines.map((line) => (
            <p key={line.id}>
              <span className="font-medium">{line.role === "user" ? "You" : "Agent"}:</span> {line.text}
            </p>
          ))}
        </div>
      </section>
      <aside className="space-y-4">
        {booking ? (
          <PayPanel
            key={booking.id}
            booking={booking}
            buyer={state?.buyer ?? null}
            clientId={clientId}
            mocked={mocked}
            endpoints={{
              order: `/api/try/bookings/${booking.id}/order`,
              authorize: `/api/try/bookings/${booking.id}/authorize`,
              mockApprove: `/api/try/bookings/${booking.id}/mock-approve`,
              deviceLink: `/api/try/bookings/${booking.id}/device-link`,
            }}
          />
        ) : (
          <section className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
            The PayPal hold appears here once the agent sets up your booking.
          </section>
        )}
        {phase === "ended" ? (
          <Link href="/dashboard" className="block text-sm text-brand underline">
            Continue as the owner →
          </Link>
        ) : null}
      </aside>
    </div>
  );
}
