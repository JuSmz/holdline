"use client";

import { cn } from "cn";
import { ArrowRight, Check, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";

import { demoStep } from "@/server/try/panel";

import { NEEDS_BUYER, type PanelBooking, type PanelEndpoints, PayPanel } from "./pay-panel";
import { useIsDesktop } from "./use-is-desktop";

export type DockBooking = PanelBooking & { status: string };

type DockProps = {
  booking: DockBooking | null;
  buyer: { email: string; password: string } | null;
  clientId: string | null;
  mocked: boolean;
  onAuthorized?: () => void;
};

/** The cookie routes of the demo pages (never a raw pay token on the call or chat page). */
export function bookingEndpoints(id: string): PanelEndpoints {
  return {
    order: `/api/try/bookings/${id}/order`,
    authorize: `/api/try/bookings/${id}/authorize`,
    mockApprove: `/api/try/bookings/${id}/mock-approve`,
    deviceLink: `/api/try/bookings/${id}/device-link`,
  };
}

/** Where the visitor is in the demo: ① book, ② approve the hold, ③ finish as the owner (as /try shows it). */
export function stepFor(booking: PanelBooking | null): 1 | 2 | 3 {
  return demoStep(booking?.panel ?? null);
}

/** Desktop: the pay panel in the right column (an explanation until the agent creates the booking). */
export function PayAside({
  booking,
  buyer,
  clientId,
  mocked,
  onAuthorized,
  className,
}: DockProps & { className?: string }) {
  const desktop = useIsDesktop();
  return (
    <aside className={cn("hidden lg:block", className)} aria-label="Payment">
      {booking && desktop ? (
        <PayPanel
          key={booking.id}
          booking={booking}
          buyer={buyer}
          clientId={clientId}
          mocked={mocked}
          endpoints={bookingEndpoints(booking.id)}
          onAuthorized={onAuthorized}
        />
      ) : (
        <div className="rounded-3xl border border-dashed border-black/10 px-6 py-10 text-center">
          <span className="mx-auto grid size-11 place-items-center rounded-full bg-neutral-soft text-muted-foreground">
            <LockKeyhole className="size-5" aria-hidden />
          </span>
          <p className="mt-3 font-medium">Your PayPal hold appears here</p>
          <p className="mx-auto mt-1 max-w-64 text-sm text-muted-foreground">
            Once you pick a time, the receptionist sets up a hold. Nothing is charged until the job is done.
          </p>
        </div>
      )}
    </aside>
  );
}

/**
 * Phones and tablets: a bar ("Approve $149.00 hold") that opens the pay panel in a bottom sheet. The
 * sheet opens on its own once, when the booking first appears, and closes shortly after approval (the
 * green confirmation then lives in the conversation).
 */
export function PayBar({
  booking,
  buyer,
  clientId,
  mocked,
  onAuthorized,
  businessName,
  className,
}: DockProps & { businessName: string; className?: string }) {
  const desktop = useIsDesktop();
  const [open, setOpen] = useState(false);
  const [autoOpenedFor, setAutoOpenedFor] = useState<string | null>(null);
  const actionable = booking ? NEEDS_BUYER.has(booking.panel) : false;
  // Once per booking, the first time it shows up (adjusting state on a prop change, not an effect).
  if (booking && autoOpenedFor !== booking.id) {
    setAutoOpenedFor(booking.id);
    if (!desktop && actionable) setOpen(true);
  }
  const authorized = booking?.panel === "authorized";
  useEffect(() => {
    if (!open || !authorized) return;
    const timer = setTimeout(() => setOpen(false), 1600);
    return () => clearTimeout(timer);
  }, [open, authorized]);

  if (desktop || !booking) return null;
  const processing = booking.panel === "processing";
  return (
    <>
      {authorized ? null : (
        <div className={className}>
          <Button
            size="lg"
            variant={actionable && !processing ? "default" : "secondary"}
            className="w-full"
            onClick={() => setOpen(true)}
          >
            {processing
              ? "PayPal is confirming…"
              : actionable
                ? `Approve ${booking.holdAmount} hold`
                : "View your booking"}
          </Button>
        </div>
      )}
      <Sheet open={open} onOpenChange={setOpen} title={businessName} description="PayPal sandbox · test money">
        <PayPanel
          key={booking.id}
          booking={booking}
          buyer={buyer}
          clientId={clientId}
          mocked={mocked}
          endpoints={bookingEndpoints(booking.id)}
          onAuthorized={onAuthorized}
          framed={false}
        />
      </Sheet>
    </>
  );
}

/** After approval, in the conversation: the green confirmation and the one next step. */
export function OwnerHandoff({ booking, className }: { booking: PanelBooking; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-success/20 bg-success-soft p-5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-success text-white">
          <Check className="size-5" strokeWidth={2.5} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-foreground">Your job is booked</p>
          <p className="mt-0.5 text-sm text-pretty text-foreground/70">
            PayPal is holding {booking.holdAmount} for {booking.serviceName}, {booking.appointment}. Now switch sides:
            finish the job as the owner and watch PayPal charge it.
          </p>
        </div>
      </div>
      <Link href="/dashboard" className={buttonVariants({ size: "lg", className: "mt-4 w-full sm:w-auto" })}>
        See it as the owner <ArrowRight aria-hidden />
      </Link>
    </div>
  );
}
