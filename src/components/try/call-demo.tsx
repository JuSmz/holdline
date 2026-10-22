"use client";

import type Vapi from "@vapi-ai/web";
import { cn } from "cn";
import { ArrowRight, Check, Laptop, LoaderCircle, type LucideIcon, Mic, MicOff, Phone, PhoneOff } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";

import { FlowSteps } from "./flow-steps";
import { type Identity, IdentityLine, useIdentity } from "./identity";
import { type DockBooking, OwnerHandoff, PayAside, PayBar, stepFor } from "./pay-dock";
import { NEEDS_BUYER } from "./pay-panel";
import { usePoll } from "./use-poll";

type Phase = "form" | "checking" | "starting" | "live" | "ended";
/** One transcript bubble: consecutive final fragments of one speaker, `at` = the latest fragment. */
type Line = { id: number; role: string; text: string; at: number };
type State = {
  booking: DockBooking | null;
  buyer: { email: string; password: string } | null;
  notify: { status: string; ok: boolean | null; via: string | null; fallback: boolean } | null;
};
type VapiMessage = { type?: string; role?: string; transcript?: string; transcriptType?: string };

const POLL_MS = 1500;
/** Without any server notice this long after authorized, the page speaks the confirmation itself. */
const FALLBACK_AFTER_MS = 4000;
/** Final transcript fragments of the same speaker this close together read as one bubble. */
const MERGE_WITHIN_MS = 5000;

async function post(url: string, body?: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * /try/call (SPEC §16): the browser call through our proxy, the live transcript, and the pay panel on
 * the same screen. The confirmation is spoken by the server (`say`); the page speaks it only as the
 * documented fallback.
 */
export function CallDemo({
  businessName,
  defaults,
  clientId,
  mocked,
}: {
  businessName: string;
  defaults: Identity;
  clientId: string | null;
  mocked: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("form");
  const who = useIdentity(defaults);
  const [error, setError] = useState<{ text: string; offerChat: boolean } | null>(null);
  const [vapiCallId, setVapiCallId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0);
  const [state, setState] = useState<State | null>(null);
  // The call timer: when the call went live, and the latest tick (frozen once it ends).
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const vapiRef = useRef<Vapi | null>(null);
  const lineId = useRef(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Per booking: when it was first seen authorized, and whether the page already spoke for it.
  const fallback = useRef<{ bookingId: string; seenAt: number; inFlight: boolean; done: boolean } | null>(null);
  // One number per press of the start button. End while connecting, "Call again" and leaving the page
  // bump it: an attempt that is no longer the latest writes no state and stops the call it created
  // (while the call is still being created, stop() can't reach it yet).
  const attempt = useRef(0);
  // Bumped by "Call again": a poll of the previous call that answers late must not show its booking.
  const generation = useRef(0);
  // The cookie or the call is gone (a fresh demo in another tab): stop polling.
  const [gone, setGone] = useState(false);

  const poll = useCallback(async () => {
    if (!vapiCallId) return;
    const gen = generation.current;
    try {
      const res = await fetch(`/api/try/state?vapi=${encodeURIComponent(vapiCallId)}`, { cache: "no-store" });
      if (gen !== generation.current) return;
      if (res.status === 401) setGone(true);
      if (!res.ok) return;
      const data = (await res.json()) as State;
      if (gen === generation.current) setState(data);
    } catch {
      // Offline for a moment: the next poll catches up.
    }
  }, [vapiCallId]);

  const booking = state?.booking ?? null;
  const authorized = booking?.panel === "authorized";
  const waiting = booking ? NEEDS_BUYER.has(booking.panel) : false;
  // An expired booking is as good as none: the slot is gone and the call can simply be made again.
  const hasBooking = booking !== null && booking.panel !== "expired";
  // The server's spoken confirmation is decided: spoken, taken over by this page, or definitely not
  // repeatable. Until then the page keeps polling, since it may have to speak it itself (§16.7).
  const noticeSettled = state?.notify ? state.notify.ok !== null && !state.notify.fallback : false;
  // Poll while something can still change: the call is on and nothing is booked yet, the hold waits
  // for the buyer or PayPal (also after hanging up), or the confirmation isn't settled mid-call.
  const pollActive =
    vapiCallId !== null &&
    !gone &&
    (booking ? waiting || (authorized && phase === "live" && !noticeSettled) : phase !== "ended");
  usePoll(poll, pollActive, { ms: POLL_MS, linger: vapiCallId && !gone ? 2 : 0 });

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
      attempt.current += 1;
      const vapi = vapiRef.current;
      if (vapi) {
        vapi.removeAllListeners();
        void vapi.stop().catch(() => {});
      }
    },
    [],
  );

  // The mm:ss timer ticks while the call is live.
  useEffect(() => {
    if (phase !== "live") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // Keep the newest transcript line in view (the transcript box scrolls, never the page).
  useEffect(() => {
    const box = transcriptRef.current;
    if (box) box.scrollTo({ top: box.scrollHeight });
  }, [lines]);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (phase !== "form") return;
    // An open "Change" form is saved first, never dropped.
    const caller = who.commit();
    if (!caller) {
      setError({ text: "Check your name and email, then start the call.", offerChat: false });
      return;
    }
    const mine = ++attempt.current;
    const stale = () => mine !== attempt.current;
    // Back to the start form with a message, unless a newer attempt (or End) owns the screen.
    const fail = (text: string, offerChat: boolean) => {
      if (stale()) return;
      setError({ text, offerChat });
      setPhase("form");
    };
    setError(null);
    setPhase("checking");
    // Mic preflight: ask once, release at once; the SDK asks again when it joins.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      fail("The microphone is blocked or missing. You can allow it in the browser, or use the chat.", true);
      return;
    }
    if (stale()) return;
    let intent: Awaited<ReturnType<typeof post>>;
    try {
      intent = await post("/api/try/call/intent", caller);
    } catch {
      fail("Couldn't reach the server. Check your connection and try again.", true);
      return;
    }
    if (stale()) return;
    if (!intent.data?.ok) {
      fail(String(intent.data?.message ?? "Couldn't start the call."), intent.status === 429);
      return;
    }

    setPhase("starting");
    let vapi: Vapi | null = null;
    /** This attempt's call is not wanted (any more): no more events, and end it if it exists. */
    const drop = async () => {
      if (!vapi) return;
      vapi.removeAllListeners();
      if (vapiRef.current === vapi) vapiRef.current = null;
      await vapi.stop().catch(() => {});
    };
    try {
      const { default: VapiClient } = await import("@vapi-ai/web");
      if (stale()) return;
      // "proxy" is a placeholder: the proxy ignores the body and picks the assistant (SPEC §14.3).
      const client = new VapiClient("proxy", `${window.location.origin}/api/vapi-proxy`);
      vapi = client;
      vapiRef.current = client;
      client.on("call-start", () => {
        if (stale()) return;
        const t = Date.now();
        setStartedAt(t);
        setNow(t);
        setPhase("live");
      });
      client.on("call-end", () => {
        if (stale()) return;
        setNow(Date.now());
        setPhase("ended");
        setVolume(0);
      });
      client.on("volume-level", (level: number) => {
        if (!stale()) setVolume(level);
      });
      client.on("message", (raw: unknown) => {
        if (stale()) return;
        const m = raw as VapiMessage;
        if (m.type === "transcript" && m.transcriptType === "final" && m.transcript) {
          const text = m.transcript.trim();
          if (!text) return;
          const role = m.role ?? "?";
          const at = Date.now();
          lineId.current += 1;
          const id = lineId.current;
          setLines((prev) => {
            const last = prev.at(-1);
            if (last && last.role === role && at - last.at <= MERGE_WITHIN_MS) {
              return [...prev.slice(0, -1), { ...last, text: `${last.text} ${text}`, at }];
            }
            return [...prev, { id, role, text, at }].slice(-60);
          });
        }
      });
      client.on("call-start-failed", () => {
        fail("Voice line busy — the chat uses the same agent and payment flow.", true);
      });
      client.on("error", () => {});
      const call = await client.start("server-selected");
      if (stale()) {
        // Ended, superseded or left while connecting: the room exists only now, so this stop() really ends it.
        await drop();
        return;
      }
      if (!call) {
        await drop();
        fail("Voice line busy — the chat uses the same agent and payment flow.", true);
        return;
      }
      setVapiCallId(call.id);
    } catch {
      await drop();
      fail("Couldn't connect the call. Please try again, or use the chat.", true);
    }
  }

  async function end() {
    // Still connecting: the pending start() stops the call once it exists (and shows nothing more).
    if (phase === "checking" || phase === "starting") attempt.current += 1;
    await vapiRef.current?.stop().catch(() => {});
    setNow(Date.now());
    setPhase("ended");
  }

  /** After a call that booked nothing: back to the start form, as if the page was just opened. */
  function callAgain() {
    generation.current += 1;
    attempt.current += 1;
    const vapi = vapiRef.current;
    vapiRef.current = null;
    if (vapi) {
      vapi.removeAllListeners();
      void vapi.stop().catch(() => {});
    }
    fallback.current = null;
    setLines([]);
    setState(null);
    setVapiCallId(null);
    setStartedAt(null);
    setNow(0);
    setMuted(false);
    setVolume(0);
    setError(null);
    setGone(false);
    setPhase("form");
  }

  /** Mid-call, once the confirmation was spoken: hang up first, then switch sides. */
  async function endAndSeeOwner() {
    await end();
    router.push("/dashboard");
  }

  const idle = phase === "form" || phase === "checking";
  const elapsed = startedAt ? clock(now - startedAt) : null;
  const level = Math.min(1, volume * 3);
  const status =
    phase === "checking"
      ? "Checking the microphone…"
      : phase === "starting"
        ? "Connecting…"
        : phase === "live"
          ? "On the call"
          : phase === "ended"
            ? "Call ended"
            : "Talk to the AI receptionist in your browser";
  const dock = { booking, buyer: state?.buyer ?? null, clientId, mocked };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5 max-lg:pb-28 sm:px-6 lg:py-8">
      <FlowSteps current={stepFor(booking)} className="mb-4" />
      <Notice className="mb-4 flex items-start gap-2 md:hidden">
        <Laptop className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span>
          The call works best on a laptop with a microphone. On a phone, the{" "}
          <Link href="/try/chat" className="font-medium text-brand underline-offset-4 hover:underline">
            chat
          </Link>{" "}
          is easier.
        </span>
      </Notice>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="overflow-hidden" aria-label="Call">
          <div className="flex flex-col items-center px-6 pt-10 pb-8 text-center sm:pt-12">
            <div className="relative grid size-32 place-items-center">
              {phase === "live" ? (
                <>
                  <span
                    aria-hidden
                    className="absolute inset-0 rounded-full bg-brand/10 transition-transform duration-150 ease-out motion-reduce:hidden"
                    style={{ transform: `scale(${0.78 + level * 0.32})` }}
                  />
                  <span
                    aria-hidden
                    className="absolute inset-3 rounded-full bg-brand/15 transition-transform duration-100 ease-out motion-reduce:hidden"
                    style={{ transform: `scale(${0.85 + level * 0.25})` }}
                  />
                </>
              ) : null}
              {phase === "starting" ? (
                <span
                  aria-hidden
                  className="absolute inset-2 rounded-full border-2 border-brand/15 border-t-brand motion-safe:animate-spin"
                />
              ) : null}
              <span
                aria-hidden
                className="relative grid size-20 place-items-center rounded-full bg-foreground text-2xl font-semibold text-background"
              >
                {businessName.charAt(0)}
              </span>
            </div>
            <h1 className="mt-5 text-xl font-semibold tracking-tight sm:text-2xl">
              {idle ? `Call ${businessName}` : businessName}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              <span aria-live="polite">{status}</span>
              {elapsed && !idle ? <span className="tabular-nums"> · {elapsed}</span> : null}
            </p>

            {idle ? (
              <>
                <form onSubmit={start} className="mt-8 flex flex-col items-center">
                  <button
                    type="submit"
                    aria-label="Start the call"
                    disabled={phase === "checking"}
                    className="grid size-20 place-items-center rounded-full bg-brand text-white shadow-[0_8px_24px_rgb(10_92_255/30%)] transition-[background-color,transform] outline-none hover:bg-brand/90 focus-visible:ring-4 focus-visible:ring-brand/25 active:scale-95 disabled:opacity-60"
                  >
                    {phase === "checking" ? (
                      <LoaderCircle className="size-8 motion-safe:animate-spin" aria-hidden />
                    ) : (
                      <Phone className="size-8" aria-hidden />
                    )}
                  </button>
                  <span aria-hidden className="mt-3 text-sm font-medium">
                    Start the call
                  </span>
                </form>
                <IdentityLine state={who} locked={phase !== "form"} verb="calling" className="mt-8 w-full max-w-md" />
                <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  <Mic className="size-3.5" aria-hidden /> Your browser asks for the microphone. Calls are transcribed.
                </p>
                {error ? (
                  <Notice tone="danger" className="mt-5 w-full max-w-md">
                    {error.text}{" "}
                    {error.offerChat ? (
                      <Link className="font-medium underline underline-offset-4" href="/try/chat">
                        Open the chat
                      </Link>
                    ) : null}
                  </Notice>
                ) : null}
              </>
            ) : phase === "ended" ? (
              <div className="mt-6 flex w-full max-w-md flex-col items-center gap-4">
                <p className="text-[15px] text-pretty text-muted-foreground">
                  {authorized
                    ? "Thanks for calling. Your hold is approved."
                    : waiting
                      ? "Your hold is still waiting — approve it to keep the slot, or finish from the email link."
                      : booking?.panel === "expired"
                        ? "The hold wasn't approved in time, so the slot was released."
                        : hasBooking
                          ? "Thanks for calling."
                          : "The call ended before anything was booked."}
                </p>
                {!hasBooking ? (
                  <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                    <Button size="lg" onClick={callAgain}>
                      <Phone aria-hidden /> Call again
                    </Button>
                    <Link href="/try/chat" className={buttonVariants({ size: "lg", variant: "secondary" })}>
                      Use the chat instead
                    </Link>
                  </div>
                ) : authorized ? null : (
                  <Link
                    href="/dashboard"
                    className={buttonVariants({ size: "lg", variant: waiting ? "secondary" : "default" })}
                  >
                    See it as the owner <ArrowRight aria-hidden />
                  </Link>
                )}
              </div>
            ) : (
              <div className="mt-8 flex items-start gap-8">
                <RoundButton
                  icon={muted ? MicOff : Mic}
                  label={muted ? "Unmute" : "Mute"}
                  pressed={muted}
                  disabled={phase !== "live"}
                  onClick={() => {
                    const next = !muted;
                    vapiRef.current?.setMuted(next);
                    setMuted(next);
                  }}
                />
                <RoundButton icon={PhoneOff} label="End" tone="danger" onClick={() => void end()} />
              </div>
            )}
          </div>

          {authorized && booking && phase === "live" ? (
            // Mid-call the visitor stays on the line: the receptionist speaks the confirmation (§16).
            <div className="mx-4 mb-4 flex flex-col items-center gap-3 sm:mx-6">
              <Notice tone="success" className="flex w-full items-start gap-2">
                <Check className="mt-0.5 size-4 shrink-0" strokeWidth={2.5} aria-hidden />
                <span>Hold approved — the receptionist confirms it on the line.</span>
              </Notice>
              {noticeSettled ? (
                <Button variant="secondary" onClick={() => void endAndSeeOwner()}>
                  End call and see it as the owner <ArrowRight aria-hidden />
                </Button>
              ) : null}
            </div>
          ) : authorized && booking && phase === "ended" ? (
            <OwnerHandoff booking={booking} className="mx-4 mb-4 sm:mx-6" />
          ) : null}

          {idle ? null : (
            <div className="border-t border-border">
              <div
                ref={transcriptRef}
                role="log"
                aria-label="Transcript"
                className="max-h-[22rem] min-h-40 space-y-2 overflow-y-auto px-4 py-4 sm:px-6"
              >
                {lines.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    The transcript appears here as you talk.
                  </p>
                ) : (
                  lines.map((line) => <TranscriptBubble key={line.id} line={line} />)
                )}
              </div>
            </div>
          )}
        </Card>

        <PayAside {...dock} className="lg:sticky lg:top-20" />
      </div>

      <PayBar
        {...dock}
        businessName={businessName}
        className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/90 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-xl lg:hidden"
      />
    </div>
  );
}

function RoundButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  pressed,
  tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  tone?: "neutral" | "danger";
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "grid size-16 place-items-center rounded-full transition-[background-color,transform] outline-none focus-visible:ring-4 focus-visible:ring-brand/25 active:scale-95 disabled:opacity-45",
          tone === "danger"
            ? "bg-danger text-white hover:bg-danger/90"
            : pressed
              ? "bg-foreground text-background"
              : "bg-neutral-soft text-foreground hover:bg-black/[0.08]",
        )}
      >
        <Icon className="size-6" aria-hidden />
      </button>
      <span aria-hidden className="text-xs text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function TranscriptBubble({ line }: { line: Line }) {
  const user = line.role === "user";
  return (
    <div
      className={cn(
        "flex motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300",
        user ? "justify-end" : "justify-start",
      )}
    >
      <p
        className={cn(
          "max-w-[80%] rounded-[20px] px-4 py-2.5 text-[15px] leading-snug",
          user ? "rounded-br-md bg-brand text-white" : "rounded-bl-md bg-neutral-soft text-foreground",
        )}
      >
        <span className="sr-only">{user ? "You: " : "Receptionist: "}</span>
        {line.text}
      </p>
    </div>
  );
}
