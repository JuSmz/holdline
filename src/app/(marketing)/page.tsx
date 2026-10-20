import { CalendarCheck, PhoneIncoming, ShieldCheck } from "lucide-react";

const STEPS = [
  {
    icon: PhoneIncoming,
    title: "Answers the call",
    body: "Every call is picked up — even when the whole crew is under a sink. The agent asks about the problem, urgency, address and time.",
  },
  {
    icon: CalendarCheck,
    title: "Books the job",
    body: "It quotes the fixed price from your price list — never a made-up number, never a discount — and offers real open slots.",
  },
  {
    icon: ShieldCheck,
    title: "Secures the payment",
    body: "While the caller is still on the line, they approve a PayPal hold. Only then is the job confirmed. You capture after the work is done.",
  },
] as const;

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl px-6">
      <section className="py-20 sm:py-28">
        <p className="mb-4 text-sm font-medium text-brand">For plumbers, electricians and other trades</p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
          Answers the call. Books the job. Secures the payment.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground text-pretty">
          Holdline is an AI phone agent for small trades businesses. No more missed calls, no-shows or unpaid invoices:
          every booking is backed by a PayPal authorization before it lands on your schedule.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <span className="inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-sm font-medium text-background">
            Live demo coming soon
          </span>
          <span className="text-sm text-muted-foreground">Try it in your browser — no account, no keys.</span>
        </div>
      </section>

      <section className="grid gap-4 pb-24 sm:grid-cols-3">
        {STEPS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-xl border p-6">
            <Icon className="size-5 text-brand" aria-hidden="true" />
            <h2 className="mt-4 font-semibold">{title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
