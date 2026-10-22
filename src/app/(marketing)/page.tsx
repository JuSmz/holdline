import { ArrowRight, CalendarCheck, Check, PhoneIncoming, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DEMO_STEPS } from "@/components/ui/steps";

const VALUES = [
  {
    icon: PhoneIncoming,
    title: "Answers the call",
    body: "Every call is picked up — even when the whole crew is under a sink. It asks about the problem, the address and a good time.",
  },
  {
    icon: CalendarCheck,
    title: "Books the job",
    body: "It quotes the fixed price from your price list — never a made-up number, never a discount — and offers real open slots.",
  },
  {
    icon: ShieldCheck,
    title: "Secures the payment",
    body: "While the caller is still on the line, they approve a PayPal hold. You charge it only after the work is done.",
  },
] as const;

const DEMO_NOTES = [
  "Chat or call the AI receptionist of a plumbing business and pick a time.",
  "Approve a PayPal hold with a sandbox buyer. Test money only.",
  "Mark the job done. PayPal charges the hold and pays the technician.",
];

/** The landing page: static (no database), one way in — the live demo. */
export default function Home() {
  return (
    <>
      <section className="px-5 pt-16 pb-16 text-center sm:pt-28 sm:pb-24">
        <p className="text-sm font-medium text-brand">For plumbers, electricians and other trades</p>
        <h1 className="mx-auto mt-4 max-w-4xl text-[2.75rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-7xl">
          Answers the call. Books the job. Secures the payment.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-pretty text-muted-foreground sm:text-xl">
          An AI receptionist that never misses a call — and backs every booking with a PayPal hold.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href="/try" className={buttonVariants({ size: "lg", className: "w-full max-w-xs sm:w-auto" })}>
            Try the live demo
          </Link>
          <a
            href="#how-it-works"
            className={buttonVariants({ size: "lg", variant: "secondary", className: "w-full max-w-xs sm:w-auto" })}
          >
            How it works
          </a>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">No account, no keys · PayPal sandbox</p>

        <HeroPreview />
      </section>

      <section aria-label="What Holdline does" className="mx-auto max-w-6xl px-5 pb-20 sm:px-6 sm:pb-28">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {VALUES.map(({ icon: Icon, title, body }) => (
            <Card key={title} className="p-6 sm:p-7">
              <span className="grid size-11 place-items-center rounded-full bg-brand-soft text-brand">
                <Icon className="size-5" aria-hidden />
              </span>
              <h2 className="mt-5 text-lg font-semibold tracking-tight">{title}</h2>
              <p className="mt-2 text-[15px] text-pretty text-muted-foreground">{body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-14 bg-canvas px-5 py-20 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <div className="text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">How the demo works</h2>
            <p className="mt-3 text-[15px] text-muted-foreground">Three steps, about three minutes.</p>
          </div>
          <ol className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {DEMO_STEPS.map((title, i) => (
              <li key={title}>
                <Card className="h-full p-6">
                  <span className="grid size-8 place-items-center rounded-full bg-foreground text-sm font-semibold text-background">
                    {i + 1}
                  </span>
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-1.5 text-sm text-pretty text-muted-foreground">{DEMO_NOTES[i]}</p>
                </Card>
              </li>
            ))}
          </ol>
          <div className="mt-10 text-center">
            <Link
              href="/try"
              className="inline-flex items-center gap-1 rounded text-[15px] font-medium text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              Start the demo <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

/** A still of the product: the chat and the hold side by side (decorative). */
function HeroPreview() {
  return (
    <div aria-hidden className="mx-auto mt-14 max-w-3xl select-none sm:mt-20">
      <div className="rounded-[28px] bg-canvas p-3 sm:p-5">
        <div className="grid grid-cols-1 gap-3 text-left sm:grid-cols-[minmax(0,1fr)_240px] sm:gap-4">
          <div className="rounded-2xl bg-card p-4 shadow-card">
            <div className="flex items-center gap-2.5 border-b border-border pb-3">
              <span className="grid size-7 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
                N
              </span>
              <span className="text-[13px] font-semibold">Northside Plumbing &amp; Electric</span>
            </div>
            <div className="mt-3 space-y-2 text-[13px] leading-snug">
              <p className="mr-auto max-w-[85%] rounded-[18px] rounded-bl-md bg-neutral-soft px-3.5 py-2">
                Hi Sam! What can we help you with today?
              </p>
              <p className="ml-auto max-w-[85%] rounded-[18px] rounded-br-md bg-brand px-3.5 py-2 text-white">
                My kitchen drain is blocked
              </p>
              <p className="mr-auto max-w-[85%] rounded-[18px] rounded-bl-md bg-neutral-soft px-3.5 py-2">
                Drain cleaning is $149.00. Maya can come Thursday, 10–12. The PayPal button is on your screen.
              </p>
              <p className="mr-auto flex max-w-[85%] items-start gap-1.5 rounded-[18px] rounded-bl-md bg-success-soft px-3.5 py-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={3} />
                Got it — PayPal confirmed the hold. You&apos;re all set.
              </p>
            </div>
          </div>
          <div className="rounded-2xl bg-card p-4 shadow-card">
            <p className="text-xs font-medium text-muted-foreground">Approve the hold</p>
            <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">$149.00</p>
            <p className="mt-1 text-xs text-muted-foreground">Charged only after the job.</p>
            <div className="mt-3 space-y-1.5 rounded-xl bg-canvas px-3 py-2.5 text-xs">
              <p className="flex justify-between gap-2">
                <span className="text-muted-foreground">Service</span>{" "}
                <span className="font-medium">Drain cleaning</span>
              </p>
              <p className="flex justify-between gap-2">
                <span className="text-muted-foreground">When</span> <span className="font-medium">Thu, 10–12</span>
              </p>
            </div>
            <p className="mt-3 flex h-9 items-center justify-center rounded-full bg-foreground text-xs font-medium text-background">
              Approve with PayPal
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
