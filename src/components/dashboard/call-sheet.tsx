"use client";

import { cn } from "cn";
import { ChevronRight, Sparkles } from "lucide-react";

import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import { StatusPill } from "@/components/ui/status-pill";

import type { LineTone } from "@/server/dashboard/wording";

import { type CallDetailJson, SampleTag, Section, TONE_SOFT } from "./shared";
import { useDetail } from "./use-live";

const CHANNEL: Record<string, string> = { chat: "Chat", web: "Web call", phone: "Phone call" };

/** The server's payment lines in a chat, toned as the customer saw them (chat-demo's NOTICE_STYLE). */
const NOTICE_TONE: Record<string, LineTone> = { authorized: "success", declined_retry: "warning", expired: "neutral" };

/** A transcript line's notice: its kind, or `true` when only "a notice" is known (then neutral, never a success). */
function noticeClass(notice: boolean | string | undefined): string | null {
  if (!notice) return null;
  return TONE_SOFT[typeof notice === "string" ? (NOTICE_TONE[notice] ?? "neutral") : "neutral"];
}

/** A conversation: the AI summary (may be wrong, never triggers anything), the linked booking, the transcript. */
export function CallSheet({
  callId,
  open,
  onOpenChange,
  tick,
  onOpenBooking,
}: {
  callId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tick: number;
  onOpenBooking: (bookingId: string) => void;
}) {
  const { data: call, missing } = useDetail<CallDetailJson>(
    callId ? `/api/dashboard/calls/${callId}` : null,
    tick,
    open,
  );
  const title =
    call?.summary?.headline ??
    (call ? `${CHANNEL[call.channel]}${call.caller ? ` with ${call.caller}` : ""}` : "Conversation");
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={call ? [CHANNEL[call.channel], call.atLabel, call.duration].filter(Boolean).join(" · ") : undefined}
    >
      {missing ? (
        <Notice tone="neutral">This conversation isn&apos;t in your demo copy any more.</Notice>
      ) : !call ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-7 pb-4">
          {call.sample ? <SampleTag /> : null}

          <section className="rounded-2xl bg-canvas p-4" aria-label="AI summary">
            <div className="flex items-center justify-between gap-3">
              <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
                <Sparkles className="size-3.5" /> AI summary
              </p>
              <span className="text-xs text-muted-foreground">May be wrong</span>
            </div>
            {call.summary ? (
              <dl className="mt-3 space-y-2.5 text-[15px]">
                {call.summary.headline && !call.summary.problem ? (
                  <SummaryLine label="In short">{call.summary.headline}</SummaryLine>
                ) : null}
                {call.summary.problem ? <SummaryLine label="Problem">{call.summary.problem}</SummaryLine> : null}
                {call.summary.outcome ? <SummaryLine label="Outcome">{call.summary.outcome}</SummaryLine> : null}
                {call.summary.followUp ? <SummaryLine label="Follow-up">{call.summary.followUp}</SummaryLine> : null}
              </dl>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                No summary yet. It&apos;s written once the conversation has a booking or ends.
              </p>
            )}
          </section>

          {call.bookings.length > 0 ? (
            <Section title={call.bookings.length > 1 ? "Bookings" : "Booking"}>
              <div className="space-y-2">
                {call.bookings.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => onOpenBooking(b.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border px-4 py-3 text-left transition-colors hover:bg-canvas focus-visible:ring-4 focus-visible:ring-brand/25 focus-visible:outline-none"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-medium">{b.serviceName}</span>
                      <span className="block text-sm text-muted-foreground">
                        {b.day} · {b.time}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <StatusPill status={b.status} flag={b.flag} />
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </span>
                  </button>
                ))}
              </div>
            </Section>
          ) : null}

          <Section title="Transcript">
            {call.lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transcript yet.</p>
            ) : (
              <ol className="space-y-2">
                {call.lines.map((l, i) => {
                  const first = i === 0 || call.lines[i - 1].speaker !== l.speaker;
                  const customer = l.speaker === "customer";
                  const notice = noticeClass(l.notice);
                  return (
                    <li key={i} className={cn("flex flex-col", customer ? "items-end" : "items-start")}>
                      {first ? (
                        <span className="mb-1 px-1 text-xs text-muted-foreground">
                          {customer ? "Customer" : "AI receptionist"}
                        </span>
                      ) : null}
                      <p
                        className={cn(
                          "max-w-[85%] rounded-2xl px-3.5 py-2 text-[15px] whitespace-pre-line",
                          notice ?? (customer ? "bg-brand text-brand-foreground" : "bg-neutral-soft text-foreground"),
                        )}
                      >
                        {l.text}
                      </p>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>
        </div>
      )}
    </Sheet>
  );
}

function SummaryLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
