"use client";

import { Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { type PanelBooking, PayPanel } from "./pay-panel";

type Line = { role: "user" | "assistant"; text: string; at: string; notice?: string };
type State = {
  booking: (PanelBooking & { status: string }) | null;
  buyer: { email: string; password: string } | null;
  lines?: Line[];
};

const POLL_MS = 1500;

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/**
 * The text chat (SPEC §15): the same agent and tools as the voice line, the pay panel beside it, and
 * the confirmation appended by the server once PayPal authorized the hold.
 */
export function ChatDemo({
  defaults,
  clientId,
  mocked,
}: {
  defaults: { firstName: string; email: string };
  clientId: string | null;
  mocked: boolean;
}) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [serverLines, setServerLines] = useState<Line[]>([]);
  // The message being answered: shown until the turn is stored (polls don't have it yet).
  const [pending, setPending] = useState<Line | null>(null);
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [form, setForm] = useState(defaults);
  const [intro, setIntro] = useState<Line[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  // Polls can overlap a turn's own refresh: only the newest request may write the state.
  const pollSeq = useRef(0);
  const poll = useCallback(async (): Promise<State | null> => {
    if (!chatId) return null;
    const seq = ++pollSeq.current;
    try {
      const res = await fetch(`/api/try/state?call=${chatId}`, { cache: "no-store" });
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
  }, [chatId]);

  useEffect(() => {
    if (!chatId) return;
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [chatId, poll]);

  const lines = [...intro, ...serverLines, ...(pending ? [pending] : [])];
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const { data } = await post("/api/chat/start", form).catch(() => ({ data: null }));
    if (!data?.ok) {
      setError(String(data?.message ?? "Couldn't start the chat. Check your connection and try again."));
      return;
    }
    setIntro((data.lines as Line[]) ?? []);
    setChips((data.chips as string[]) ?? []);
    setChatId(String(data.chatId));
  }

  async function send(text: string) {
    const message = text.trim();
    if (!chatId || !message || busy) return;
    const previousChips = chips;
    const userLinesBefore = serverLines.filter((l) => l.role === "user").length;
    setBusy(true);
    setError(null);
    setDraft("");
    setChips([]);
    setPending({ role: "user", text: message, at: new Date().toISOString() });
    // failed: the server said it didn't keep the turn. unknown: no answer (offline, a proxy timeout
    // while the turn may still be running), so the transcript decides.
    let outcome: "ok" | "failed" | "unknown" = "unknown";
    try {
      const { data } = await post("/api/chat", { chatId, message });
      if (data?.ok) {
        outcome = "ok";
        setChips((data.chips as string[]) ?? []);
      } else if (data) {
        outcome = data.stored === true ? "ok" : "failed";
        setError(String(data.message ?? "Something went wrong. Please try again."));
      } else {
        setError("The answer is taking a while — it will appear here, or send your message again.");
      }
    } catch {
      outcome = "failed"; // most likely never arrived; the transcript check below still guards
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      const latest = await poll();
      const kept = (latest?.lines ?? []).filter((l) => l.role === "user").length > userLinesBefore;
      if (outcome === "failed" && !kept) {
        // Give the customer their message and choices back.
        setDraft(message);
        setChips(previousChips);
      }
      setPending(null);
      setBusy(false);
    }
  }

  if (!chatId) {
    return (
      <form onSubmit={start} className="max-w-md space-y-4 rounded-xl border p-6">
        <p className="text-sm text-muted-foreground">
          Made-up details are fine: this is a demo. The agent uses the name and email from this form.
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
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" size="lg">
          Start the chat
        </Button>
      </form>
    );
  }

  const booking = state?.booking ?? null;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="flex min-h-[520px] flex-col rounded-xl border" aria-label="Chat with the receptionist">
        <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
          {lines.map((line, i) => (
            <div key={`${line.at}-${i}`} className={line.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <p
                data-role={line.role}
                className={
                  line.role === "user"
                    ? "max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground"
                    : line.notice
                      ? "max-w-[80%] rounded-2xl rounded-bl-sm border border-emerald-600/30 bg-emerald-50 px-3 py-2 text-sm whitespace-pre-wrap dark:bg-emerald-950/30"
                      : "max-w-[80%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap"
                }
              >
                {line.text}
              </p>
            </div>
          ))}
          {busy ? <p className="text-sm text-muted-foreground">Typing…</p> : null}
          <div ref={endRef} />
        </div>
        {chips.length > 0 ? (
          <div className="flex flex-wrap gap-2 border-t px-4 py-3">
            {chips.map((chip) => (
              <Button key={chip} variant="outline" size="sm" disabled={busy} onClick={() => void send(chip)}>
                {chip}
              </Button>
            ))}
          </div>
        ) : null}
        {error ? <p className="px-4 pb-2 text-sm text-destructive">{error}</p> : null}
        <form
          className="flex gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <input
            className="flex-1 rounded-lg border bg-background px-3 py-2 text-sm"
            placeholder="Type a message"
            aria-label="Message"
            value={draft}
            maxLength={500}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" size="lg" disabled={busy || !draft.trim()} aria-label="Send">
            <Send />
          </Button>
        </form>
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
            onAuthorized={() => {
              // The server also posts the confirmation itself after the authorize; this only speeds it up.
              void post("/api/chat/event", { bookingId: booking.id })
                .catch(() => null)
                .then(() => poll());
            }}
          />
        ) : (
          <section className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
            The PayPal hold appears here once the agent sets up your booking.
          </section>
        )}
      </aside>
    </div>
  );
}
