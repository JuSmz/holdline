"use client";

import { cn } from "cn";
import { ArrowUp, CircleAlert, CircleCheck, Clock } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import { FlowSteps } from "./flow-steps";
import { displayName, type Identity, IdentityLine, useIdentity } from "./identity";
import { type DockBooking, OwnerHandoff, PayAside, PayBar, stepFor } from "./pay-dock";
import { NEEDS_BUYER } from "./pay-panel";
import { useIsDesktop } from "./use-is-desktop";
import { usePoll } from "./use-poll";

type Line = { role: "user" | "assistant"; text: string; at: string; notice?: string };
type State = {
  booking: DockBooking | null;
  buyer: { email: string; password: string } | null;
  lines?: Line[];
  /** The current booking's "authorized" confirmation; for a chat it is stored with its line. */
  notify?: { status: string; ok: boolean | null; via: string | null; fallback: boolean } | null;
};

/** A conversation picked back up from `/try/chat?c=<id>` (checked on the server), with its current state. */
export type ChatResume = { chatId: string; identity: Identity; state: State };
/** The message being answered, and how many user lines the server had when it was sent. */
type Pending = { line: Line; userLinesBefore: number };

const POLL_MS = 1500;
/** How long a page opened from a stale history entry waits for the server's copy of its conversation. */
const RESTORE_TIMEOUT_MS = 8000;
const SLOW_ANSWER = "The answer is taking a while — it will appear here, or send your message again.";

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const userCount = (lines: Line[]) => lines.filter((l) => l.role === "user").length;

/** Whether the receptionist answered the user line that followed `userLinesBefore` (a payment notice isn't an answer). */
function answeredAfter(lines: Line[], userLinesBefore: number): boolean {
  let users = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].role !== "user") continue;
    users += 1;
    if (users === userLinesBefore + 1) return lines.slice(i + 1).some((l) => l.role === "assistant" && !l.notice);
  }
  return false;
}

/**
 * The text chat (SPEC §15): the same agent and tools as the voice line, the pay panel beside it (a
 * bottom sheet on phones), and the confirmation appended by the server once PayPal authorized the
 * hold. The chat opens at once with a local greeting; the server session starts with the first
 * message, using the identity shown (editable until then).
 */
export function ChatDemo({
  businessName,
  starters,
  defaults,
  clientId,
  mocked,
  resume = null,
}: {
  businessName: string;
  starters: string[];
  defaults: Identity;
  clientId: string | null;
  mocked: boolean;
  resume?: ChatResume | null;
}) {
  const desktop = useIsDesktop();
  const router = useRouter();
  const searchParams = useSearchParams();
  const who = useIdentity(resume?.identity ?? defaults);
  const identity = who.identity;
  const [chatId, setChatId] = useState<string | null>(resume?.chatId ?? null);
  const [serverLines, setServerLines] = useState<Line[]>(resume?.state.lines ?? []);
  // Shown until the turn is stored (polls don't have it yet).
  const [pending, setPending] = useState<Pending | null>(null);
  // A resumed chat has no stored quick replies; the next answer brings fresh ones.
  const [chips, setChips] = useState<string[]>(resume ? [] : starters);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The error is the "taking a while" kind for the message sent after this many user lines: it goes
  // away by itself once the answer to that message shows up.
  const [slowFor, setSlowFor] = useState<number | null>(null);
  if (slowFor !== null && answeredAfter(serverLines, slowFor)) {
    setSlowFor(null);
    setError(null);
  }
  const [state, setState] = useState<State | null>(resume?.state ?? null);
  // The cookie or the conversation is gone (a fresh demo in another tab): stop polling.
  const [gone, setGone] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);

  // Back or Forward into `?c=<id>` can show the page as it was rendered before the chat had an id
  // (the id is added with replaceState). Ask the server for that conversation instead of offering a
  // blank chat under its URL; the page then remounts with it (keyed by the id). A conversation the
  // server won't resume redirects to /try/chat, which drops the `c` and ends this wait as well.
  const [restoreStarted] = useState(() => resume === null && searchParams.has("c"));
  const [restoreGaveUp, setRestoreGaveUp] = useState(false);
  const restoring = restoreStarted && !restoreGaveUp && searchParams.has("c");
  useEffect(() => {
    if (!restoreStarted) return;
    router.refresh();
    // No answer (offline): leave the page usable; the next message starts a new conversation.
    const timer = setTimeout(() => setRestoreGaveUp(true), RESTORE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [restoreStarted, router]);

  // Polls can overlap a turn's own refresh: only the newest request may write the state.
  const pollSeq = useRef(0);
  const poll = useCallback(async (id: string): Promise<State | null> => {
    const seq = ++pollSeq.current;
    try {
      const res = await fetch(`/api/try/state?call=${id}`, { cache: "no-store" });
      if (res.status === 401 || res.status === 404) setGone(true);
      if (!res.ok) return null;
      const data = (await res.json()) as State;
      // A newer poll owns the screen; the caller still gets this answer.
      if (seq !== pollSeq.current) return data;
      setState(data);
      // The server transcript is the truth (it holds confirmations the server appended).
      if (data.lines) setServerLines(data.lines);
      return data;
    } catch {
      // Offline for a moment: the next poll catches up.
      return null;
    }
  }, []);

  const booking = state?.booking ?? null;
  const authorized = booking?.panel === "authorized";
  // The chat's confirmation line and its notify row are written in one transaction.
  const noticeIn = state?.notify != null;
  // Poll while something can still change on its own: no booking yet (a slow answer may still land),
  // the hold waiting for the buyer or PayPal, or approved before the server's confirmation is in. A
  // final booking stops it (a few lingering polls catch a closing line); the next turn polls itself.
  // A slow answer keeps it going too, so it does appear as promised.
  const pollActive =
    chatId !== null &&
    !gone &&
    (!booking || NEEDS_BUYER.has(booking.panel) || (authorized && !noticeIn) || slowFor !== null);
  usePoll(async () => (chatId ? poll(chatId) : null), pollActive, { ms: POLL_MS, linger: chatId && !gone ? 3 : 0 });

  const greeting: Line = {
    role: "assistant",
    text: `Hi ${displayName(identity)}! This is ${businessName}. What can we help you with today?`,
    at: "greeting",
  };
  const showPending = pending !== null && userCount(serverLines) <= pending.userLinesBefore;
  const lines = restoring ? [] : [greeting, ...serverLines, ...(showPending ? [pending.line] : [])];
  const typing = busy && lines.at(-1)?.role === "user";
  // After approval the handoff is part of the conversation: right after the server's confirmation
  // (so later messages follow it), or at the end until that line is in.
  let handoffAfter = authorized && booking ? lines.length - 1 : -1;
  if (handoffAfter >= 0 && noticeIn) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].notice === "authorized") {
        handoffAfter = i;
        break;
      }
    }
  }
  // Only one blue button: while the pay bar asks for approval, or once "See it as the owner" is the next
  // step (after approval), Send is dark.
  const payPending = booking !== null && NEEDS_BUYER.has(booking.panel) && booking.panel !== "processing";
  // Quick replies only while they still fit: none once the hold is approved (or the booking ended).
  const visibleChips = busy || restoring || (booking && !NEEDS_BUYER.has(booking.panel)) ? [] : chips;

  // Keep the newest line in view: the card scrolls on desktop, the page itself on phones (above the
  // sticky composer). The greeting alone never scrolls the page.
  const started = serverLines.length > 0 || pending !== null;
  useEffect(() => {
    if (!started) return;
    const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    const scroller = scrollerRef.current;
    // The media query itself, not only the state: the first turn can run before useIsDesktop has settled,
    // and scrolling the window then would push the chat header out of view.
    const wide = desktop || window.matchMedia("(min-width: 64rem)").matches;
    if (wide && scroller) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      return;
    }
    const end = endRef.current;
    if (!end) return;
    const covered = footerRef.current?.offsetHeight ?? 0;
    const bottom = end.getBoundingClientRect().bottom + window.scrollY;
    window.scrollTo({ top: Math.max(0, bottom - (window.innerHeight - covered - 12)), behavior });
  }, [started, lines.length, typing, authorized, desktop, visibleChips.length]);

  /** The server session, created with the first message (with the identity shown, or just edited). */
  async function ensureChat(caller: Identity): Promise<string | null> {
    if (chatId) return chatId;
    const { status, data } = await post("/api/chat/start", caller).catch(() => ({ status: 0, data: null }));
    if (!data?.ok) {
      setError(
        typeof data?.message === "string"
          ? data.message
          : status === 400
            ? "Check your name and email, then try again."
            : "Couldn't start the chat. Check your connection and try again.",
      );
      return null;
    }
    const id = String(data.chatId);
    setChatId(id);
    // Resumable: Back, a reload or the Customer tab return to this conversation (the router keeps the URL
    // in sync without re-rendering the page; a Back into it from another page is picked up on mount).
    window.history.replaceState(null, "", `/try/chat?c=${encodeURIComponent(id)}`);
    return id;
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || restoring) return;
    // The first message starts the chat: an open "Change" form is saved first, never dropped.
    const caller = chatId ? identity : who.commit();
    if (!caller) {
      setSlowFor(null);
      setError("Check your name and email above, then send again.");
      return;
    }
    const previousChips = chips;
    const userLinesBefore = userCount(serverLines);
    setBusy(true);
    setError(null);
    setSlowFor(null);
    setDraft("");
    setChips([]);
    setPending({ line: { role: "user", text: message, at: new Date().toISOString() }, userLinesBefore });

    const id = await ensureChat(caller);
    if (!id) {
      // Nothing was sent: give the customer their message and choices back.
      setDraft((d) => d || message);
      setChips(previousChips);
      setPending(null);
      setBusy(false);
      return;
    }

    // failed: the server said it didn't keep the turn. unknown: no answer (offline, a proxy timeout
    // while the turn may still be running), so the transcript decides.
    let outcome: "ok" | "failed" | "unknown" = "unknown";
    let unreachable = false;
    try {
      const { data } = await post("/api/chat", { chatId: id, message });
      if (data?.ok) {
        outcome = "ok";
        setChips((data.chips as string[]) ?? []);
      } else if (data) {
        outcome = data.stored === true ? "ok" : "failed";
        setError(String(data.message ?? "Something went wrong. Please try again."));
      } else {
        setError(SLOW_ANSWER);
        setSlowFor(userLinesBefore);
      }
    } catch {
      outcome = "failed"; // most likely never arrived; the transcript check below still guards
      unreachable = true;
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      const latest = await poll(id);
      const kept = userCount(latest?.lines ?? []) > userLinesBefore;
      if (outcome === "failed" && !kept) {
        // Give the customer their message and choices back.
        setDraft((d) => d || message);
        setChips(previousChips);
      } else if (unreachable) {
        // It did arrive after all: the answer shows up here like a slow one.
        setError(SLOW_ANSWER);
        setSlowFor(userLinesBefore);
      }
      setPending(null);
      setBusy(false);
    }
  }

  const onAuthorized = () => {
    if (!booking || !chatId) return;
    // The server also posts the confirmation itself after the authorize; this only speeds it up.
    void post("/api/chat/event", { bookingId: booking.id })
      .catch(() => null)
      .then(() => poll(chatId));
  };
  const dock = { booking, buyer: state?.buyer ?? null, clientId, mocked, onAuthorized };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col px-4 pt-4 sm:px-6 lg:h-[calc(100dvh-3.5rem)] lg:min-h-[620px] lg:py-6">
      <FlowSteps current={stepFor(booking)} className="mb-3 shrink-0 sm:mb-4" />
      <div className="grid flex-1 gap-6 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card
          className="flex min-h-[calc(100dvh-7rem)] flex-col max-sm:-mx-4 max-sm:rounded-none max-sm:border-x-0 lg:min-h-0"
          aria-label="Chat with the receptionist"
        >
          <header className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-5">
            <span
              aria-hidden
              className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-sm font-semibold text-background"
            >
              {businessName.charAt(0)}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[15px] leading-tight font-semibold">{businessName}</h1>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span aria-hidden className="size-1.5 rounded-full bg-success" /> AI receptionist · replies in seconds
              </p>
            </div>
          </header>
          {restoring ? null : (
            <IdentityLine
              state={who}
              locked={chatId !== null || busy}
              className="border-b border-border bg-canvas/60 px-4 py-2 sm:px-5"
            />
          )}

          <div ref={scrollerRef} className="flex-1 px-3 py-4 sm:px-5 lg:min-h-0 lg:overflow-y-auto">
            <div role="log" aria-label="Conversation" aria-busy={restoring || undefined} className="space-y-2">
              {restoring ? (
                <p className="py-10 text-center text-sm text-muted-foreground">Picking up your conversation…</p>
              ) : null}
              {lines.map((line, i) => (
                <Fragment key={i}>
                  <Bubble line={line} />
                  {i === handoffAfter && booking ? (
                    <div className="py-2">
                      <OwnerHandoff booking={booking} />
                    </div>
                  ) : null}
                </Fragment>
              ))}
              {typing ? <Typing /> : null}
            </div>
            <div ref={endRef} />
          </div>

          <div
            ref={footerRef}
            className="sticky bottom-0 z-10 border-t border-border bg-card/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl sm:rounded-b-2xl lg:static lg:bg-card"
          >
            <PayBar {...dock} businessName={businessName} className="px-3 pt-3 sm:px-4" />
            {visibleChips.length > 0 ? (
              <div className="flex flex-wrap gap-2 px-3 pt-3 sm:px-4" aria-label="Quick replies" role="group">
                {visibleChips.map((chip) => (
                  <Button
                    key={chip}
                    variant="outline"
                    size="sm"
                    className="h-auto min-h-8 border-brand/25 py-1.5 whitespace-normal text-brand hover:bg-brand-soft motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
                    onClick={() => void send(chip)}
                  >
                    {chip}
                  </Button>
                ))}
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="px-4 pt-3 text-sm text-danger sm:px-5">
                {error}
              </p>
            ) : null}
            <form
              className="flex items-center gap-2 p-3 sm:px-4"
              onSubmit={(e) => {
                e.preventDefault();
                void send(draft);
              }}
            >
              <input
                className="h-11 min-w-0 flex-1 rounded-full border border-input bg-card px-4 text-base outline-none sm:text-[15px] transition-shadow placeholder:text-muted-foreground focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-brand/15"
                placeholder="Message"
                aria-label="Message"
                autoComplete="off"
                enterKeyHint="send"
                value={draft}
                maxLength={500}
                disabled={restoring}
                onChange={(e) => setDraft(e.target.value)}
              />
              <Button
                type="submit"
                size="icon"
                variant={payPending || authorized ? "dark" : "default"}
                aria-label="Send"
                disabled={busy || restoring || !draft.trim()}
                className="size-11 disabled:bg-neutral-soft disabled:text-muted-foreground disabled:opacity-100"
              >
                <ArrowUp className="size-5" strokeWidth={2.5} aria-hidden />
              </Button>
            </form>
          </div>
        </Card>

        <PayAside {...dock} className="lg:min-h-0 lg:overflow-y-auto" />
      </div>
    </div>
  );
}

/** The server's fixed payment lines (not model output) stand apart from ordinary replies. */
const NOTICE_STYLE: Record<string, { icon: typeof CircleCheck; bubble: string; iconColor: string }> = {
  authorized: { icon: CircleCheck, bubble: "bg-success-soft", iconColor: "text-success" },
  declined_retry: { icon: CircleAlert, bubble: "bg-warning-soft", iconColor: "text-warning" },
  expired: { icon: Clock, bubble: "bg-neutral-soft", iconColor: "text-muted-foreground" },
};

function Bubble({ line }: { line: Line }) {
  const user = line.role === "user";
  const notice = line.notice ? (NOTICE_STYLE[line.notice] ?? NOTICE_STYLE.expired) : null;
  return (
    <div
      className={cn(
        "flex motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300",
        user ? "justify-end" : "justify-start",
      )}
    >
      {notice ? (
        <p
          data-role={line.role}
          className={cn(
            "flex max-w-[85%] items-start gap-2 rounded-[20px] rounded-bl-md px-4 py-2.5 text-[15px] leading-snug whitespace-pre-wrap text-foreground",
            notice.bubble,
          )}
        >
          <notice.icon className={cn("mt-[3px] size-4 shrink-0", notice.iconColor)} aria-hidden />
          {line.text}
        </p>
      ) : (
        <p
          data-role={line.role}
          className={cn(
            "max-w-[80%] rounded-[20px] px-4 py-2.5 text-[15px] leading-snug whitespace-pre-wrap",
            user ? "rounded-br-md bg-brand text-white" : "rounded-bl-md bg-neutral-soft text-foreground",
          )}
        >
          {line.text}
        </p>
      )}
    </div>
  );
}

function Typing() {
  return (
    <div className="flex justify-start motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      <span className="inline-flex h-10 items-center gap-1 rounded-[20px] rounded-bl-md bg-neutral-soft px-4">
        <span className="sr-only">The receptionist is typing…</span>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            aria-hidden
            className="size-2 rounded-full bg-muted-foreground/50 motion-safe:animate-bounce"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
    </div>
  );
}
