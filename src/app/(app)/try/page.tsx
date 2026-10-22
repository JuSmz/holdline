import { cn } from "cn";
import { ArrowRight, Check, Hourglass, MessageCircle, Phone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LogoGlyph } from "@/components/brand/logo";
import { FlowSteps } from "@/components/try/flow-steps";
import { StartDemo } from "@/components/try/start-demo";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Pill } from "@/components/ui/status-pill";
import { DEMO_STEPS } from "@/components/ui/steps";
import { getDb } from "@/db/client";
import { latestConversation, type ResumeView } from "@/server/try/state";
import { dailyVoiceMinutes, voiceMinutesLeft } from "@/server/try/web-call";
import { currentDemoWorkspace } from "@/server/workspaces/session";

export const metadata: Metadata = { title: "Try it", robots: { index: false, follow: false } };

const STEP_NOTES = [
  "Chat or call the AI receptionist and pick a time.",
  "A sandbox buyer approves it — test money only.",
  "Mark the job done; PayPal charges the hold.",
];

const choice =
  "group flex flex-col rounded-2xl border border-border bg-card p-6 text-left shadow-card outline-none transition-[transform,box-shadow] duration-200";

/**
 * /try (SPEC §17): GET has no side effects; "Start the demo" is a Server Action POST. `?fresh=1`
 * (after "Start a fresh demo") lands on the same start card. With a demo copy, the steps show where the
 * newest conversation (last 24 h) stands, with a way back into it.
 */
export default async function TryPage() {
  const ws = await currentDemoWorkspace();
  if (!ws) return <StartCard />;

  const db = getDb();
  const now = new Date();
  const [minutesLeft, latest] = await Promise.all([
    dailyVoiceMinutes() > 0 ? voiceMinutesLeft(db, now) : Promise.resolve(0),
    latestConversation(db, ws, now),
  ]);
  const voice = minutesLeft > 0;
  const next = latest ? continueCard(latest) : null;
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-14">
      <FlowSteps current={latest?.step ?? 1} />
      {next ? <ContinueCard {...next} /> : null}
      <p className={cn("text-sm text-muted-foreground", next ? "mt-10" : "mt-8")} data-testid="demo-badge">
        Your private demo copy · Northside {ws.label}
      </p>
      {next ? (
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-balance">Or start a new conversation</h2>
      ) : (
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Book a job like a customer would
        </h1>
      )}
      <p className="mt-2 text-[15px] text-muted-foreground">
        Reach {ws.name} the way your customers do. Made-up details are fine.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Link
          href="/try/chat"
          className={cn(
            choice,
            "hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgb(0_0_0/4%),0_16px_40px_rgb(0_0_0/8%)] focus-visible:ring-4 focus-visible:ring-brand/25",
          )}
        >
          <span className="grid size-12 place-items-center rounded-full bg-brand-soft text-brand">
            <MessageCircle className="size-6" aria-hidden />
          </span>
          <span className="mt-5 text-xl font-semibold tracking-tight">Chat</span>
          <Pill tone="brand" className="mt-2 self-start">
            Recommended · works everywhere
          </Pill>
          <span className="mt-3 text-sm text-muted-foreground">
            Text with the AI receptionist on any device — phone or laptop.
          </span>
          <span className="mt-auto inline-flex items-center gap-1 pt-5 text-sm font-medium text-brand">
            Start chatting{" "}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
          </span>
        </Link>

        {voice ? (
          <Link
            href="/try/call"
            className={cn(
              choice,
              "hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgb(0_0_0/4%),0_16px_40px_rgb(0_0_0/8%)] focus-visible:ring-4 focus-visible:ring-brand/25",
            )}
          >
            <CallChoice minutesLeft={minutesLeft} />
            <span className="mt-auto inline-flex items-center gap-1 pt-5 text-sm font-medium text-brand">
              Start a call{" "}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </span>
          </Link>
        ) : (
          <div className={cn(choice, "shadow-none")} aria-disabled="true">
            <div className="opacity-50">
              <CallChoice minutesLeft={0} />
            </div>
            <p className="mt-auto pt-5 text-sm text-muted-foreground">
              No voice minutes left today. The chat uses the same agent and payment flow.
            </p>
          </div>
        )}
      </div>

      {next?.href.startsWith("/dashboard") ? null : (
        <Link
          href="/dashboard"
          className="mt-8 inline-flex rounded text-sm font-medium text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          Skip to the owner view →
        </Link>
      )}
    </div>
  );
}

type Next = { tone: "waiting" | "done"; title: string; body: string; cta: string; href: string };

/** The one way back in for the newest conversation, or null when there is nothing to pick up. */
function continueCard(c: ResumeView): Next | null {
  const chat = c.channel === "chat";
  const resumeChat = `/try/chat?c=${encodeURIComponent(c.callId)}`;
  if (c.step === 1) {
    // A browser call can't be picked back up; an open chat can.
    if (!chat) return null;
    return {
      tone: "waiting",
      title: "Your chat is still open",
      body: "Pick up where you left off with the receptionist.",
      cta: "Continue your chat",
      href: resumeChat,
    };
  }
  if (c.step === 2) {
    return chat
      ? {
          tone: "waiting",
          title: "Your hold is waiting for approval",
          body: "Approve it in your chat to keep the time you picked.",
          cta: "Continue your chat",
          href: resumeChat,
        }
      : {
          tone: "waiting",
          title: "Your hold is waiting for approval",
          body: "The email your customer would get has the approval link. It's in the owner's Outbox.",
          cta: "Continue as the owner",
          href: "/dashboard?tab=outbox",
        };
  }
  return {
    tone: "done",
    title: c.panel === "authorized" ? "Your job is booked" : "Your booking is with the owner",
    body:
      c.panel === "authorized"
        ? "PayPal is holding the amount. Now finish the job as the owner and watch PayPal charge it."
        : "See how it ended, with every PayPal step, in the owner view.",
    cta: "Continue as the owner",
    href: "/dashboard",
  };
}

function ContinueCard({ tone, title, body, cta, href }: Next) {
  const Icon = tone === "done" ? Check : Hourglass;
  return (
    <Card className="mt-6 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:p-6" data-testid="continue-card">
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-full",
          tone === "done" ? "bg-success text-white" : "bg-warning-soft text-warning",
        )}
      >
        <Icon className="size-5" strokeWidth={2.5} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        {/* The page's next step, so its heading leads the page. */}
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{body}</p>
      </div>
      <Link href={href} className={buttonVariants({ size: "lg", className: "w-full sm:w-auto" })}>
        {cta} <ArrowRight aria-hidden />
      </Link>
    </Card>
  );
}

function CallChoice({ minutesLeft }: { minutesLeft: number }) {
  return (
    <>
      <span className="grid size-12 place-items-center rounded-full bg-neutral-soft text-foreground">
        <Phone className="size-6" aria-hidden />
      </span>
      <span className="mt-5 block text-xl font-semibold tracking-tight">Call in browser</span>
      <span className="mt-2 block text-sm text-muted-foreground">
        Laptop with a microphone · {minutesLeft} voice {minutesLeft === 1 ? "minute" : "minutes"} left today
      </span>
      <span className="mt-3 block text-sm text-muted-foreground">Talk to the same agent, out loud.</span>
    </>
  );
}

/** No demo copy yet: one card, one action. */
function StartCard() {
  return (
    <div className="mx-auto flex max-w-md flex-col justify-center px-4 py-10 sm:min-h-[calc(100dvh-3.5rem-6rem)] sm:py-16">
      <Card className="px-6 py-8 sm:px-8 sm:py-10">
        <div className="text-center">
          <LogoGlyph className="mx-auto size-12" />
          <h1 className="mt-5 text-3xl font-semibold tracking-tight">Try Holdline live</h1>
          <p className="mt-2 text-[15px] text-pretty text-muted-foreground">
            Your own private copy of a plumbing business, with sample history.
          </p>
        </div>
        <ol className="mt-7 space-y-3.5" aria-label="Demo steps">
          {DEMO_STEPS.map((label, i) => (
            <li key={label} className="flex items-start gap-3">
              <span
                className={cn(
                  "mt-px grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold",
                  i === 0 ? "bg-brand text-white" : "bg-neutral-soft text-muted-foreground",
                )}
              >
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-medium">{label}</span>
                <span className="block text-sm text-muted-foreground">{STEP_NOTES[i]}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-8">
          <StartDemo />
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground">PayPal sandbox — no real money moves.</p>
      </Card>
    </div>
  );
}
