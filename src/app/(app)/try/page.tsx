import { MessageSquare, Mic, Store } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { StartDemo } from "@/components/try/start-demo";
import { buttonVariants } from "@/components/ui/button";
import { getDb } from "@/db/client";
import { dailyVoiceMinutes, voiceMinutesLeft } from "@/server/try/web-call";
import { currentDemoWorkspace } from "@/server/workspaces/session";

export const metadata: Metadata = { title: "Try it", robots: { index: false, follow: false } };

const STEPS = ["Be the customer: describe a problem", "Approve the PayPal hold", "Be the owner: finish the job"];

/** /try (SPEC §17): GET has no side effects; "Start the demo" is a Server Action POST. */
export default async function TryPage() {
  const ws = await currentDemoWorkspace();
  const minutesLeft = dailyVoiceMinutes() > 0 ? await voiceMinutesLeft(getDb(), new Date()) : 0;
  return (
    <div className="mx-auto max-w-4xl space-y-8 px-6 py-10">
      <header>
        <p className="text-sm font-medium text-brand">Live demo · PayPal sandbox</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Book a job like a customer would</h1>
        <ol className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step} className="rounded-lg border px-3 py-2">
              <span className="font-semibold">{["①", "②", "③"][i]}</span> {step}
            </li>
          ))}
        </ol>
      </header>

      {ws ? (
        <section className="space-y-6">
          <p className="inline-flex rounded-full border px-3 py-1 text-sm" data-testid="demo-badge">
            Your private demo copy · Northside {ws.label}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Link href="/try/chat" className="rounded-xl border p-5 hover:bg-muted">
              <MessageSquare className="size-5 text-brand" />
              <p className="mt-2 font-semibold">Chat</p>
              <p className="text-sm text-muted-foreground">Type with the receptionist. Works on any device.</p>
            </Link>
            <Link href="/try/call" className="rounded-xl border p-5 hover:bg-muted">
              <Mic className="size-5 text-brand" />
              <p className="mt-2 font-semibold">Call in browser</p>
              <p className="text-sm text-muted-foreground">
                Talk to the same agent. Needs a microphone. {minutesLeft} voice minutes left today.
              </p>
            </Link>
          </div>
          <Link href="/dashboard" className={buttonVariants({ variant: "outline" })}>
            <Store /> Owner dashboard
          </Link>
        </section>
      ) : (
        <StartDemo />
      )}
    </div>
  );
}
