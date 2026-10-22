"use client";

import { Tabs } from "@base-ui/react/tabs";
import { cn } from "cn";
import { CheckCircle2, CircleAlert, Info } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Notice } from "@/components/ui/notice";
import type { ActionKey } from "@/server/dashboard/actions";

import { BookingSheet, type BookingTarget } from "./booking-sheet";
import { BookingsTab } from "./bookings-tab";
import { CallSheet } from "./call-sheet";
import { CallsTab } from "./calls-tab";
import { EmailSheet } from "./email-sheet";
import { OutboxTab } from "./outbox-tab";
import { Overview } from "./overview";
import { PaymentsTab } from "./payments-tab";
import { PriceListTab } from "./price-list-tab";
import type { State } from "./shared";
import { DASHBOARD_TABS, type DashboardTab, tabFrom } from "./tabs";
import { type LiveStatus, useLive } from "./use-live";

type Toast = { id: number; text: string; tone: "success" | "info" | "danger" };

/** A tab panel is a focus stop (Base UI gives it tabIndex 0): it shows the same ring as the tabs. */
const PANEL = "rounded-2xl outline-none focus-visible:ring-4 focus-visible:ring-brand/25";

/**
 * The owner view of the visitor's demo copy (SPEC §18): six tabs, a booking / call / email sheet, and a
 * poll every 3 s while visible, so money movement shows up in place within seconds.
 */
export function OwnerDashboard({ initial }: { initial: State }) {
  const { data: state, status, tick, refresh } = useLive<State>("/api/dashboard/state", initial);
  // The URL is the truth (`?tab=`): Back into this page can re-show a payload rendered for another tab,
  // since tab changes only replace the history entry. The local state answers a click at once.
  const searchParams = useSearchParams();
  const urlTab = tabFrom(searchParams.get("tab") ?? undefined);
  const [tab, setTab] = useState<DashboardTab>(urlTab);
  const [seenUrlTab, setSeenUrlTab] = useState(urlTab);
  if (urlTab !== seenUrlTab) {
    setSeenUrlTab(urlTab);
    setTab(urlTab);
  }
  const [booking, setBooking] = useState<{ target: BookingTarget | null; open: boolean }>({
    target: null,
    open: false,
  });
  const [call, setCall] = useState<{ id: string | null; open: boolean }>({ id: null, open: false });
  const [email, setEmail] = useState<{ id: string | null; open: boolean }>({ id: null, open: false });
  const [toast, setToast] = useState<Toast | null>(null);
  const nonce = useRef(0);

  const changeTab = useCallback((next: DashboardTab) => {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }, []);

  const openBooking = useCallback((id: string, action?: ActionKey) => {
    nonce.current += 1;
    setCall((c) => ({ ...c, open: false }));
    setBooking({ target: { id, action, nonce: nonce.current }, open: true });
  }, []);
  const openCall = useCallback((id: string) => {
    setBooking((b) => ({ ...b, open: false }));
    setCall({ id, open: true });
  }, []);

  const notify = useCallback((text: string, tone: Toast["tone"]) => {
    setToast({ id: Date.now(), text, tone });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6_000);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <div className="mx-auto max-w-6xl px-4 pt-8 pb-16 sm:px-6 sm:pt-10">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{state.business.name}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Owner view · demo copy {state.business.label}</p>
        </div>
        <LiveBadge status={status} />
      </header>

      {status === "gone" ? (
        <Notice tone="warning" className="mt-6">
          This demo copy no longer exists.{" "}
          <Link href="/try" className="font-medium underline underline-offset-4">
            Start a new one
          </Link>
        </Notice>
      ) : null}

      <Tabs.Root value={tab} onValueChange={(v) => changeTab(v as DashboardTab)} className="mt-6">
        <div className="-mx-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-4 pb-1 sm:mx-0 sm:px-0">
          <Tabs.List className="relative inline-flex rounded-full bg-black/[0.06] p-1">
            {DASHBOARD_TABS.map((t) => (
              <Tabs.Tab
                key={t.key}
                value={t.key}
                className="relative z-[1] h-8 rounded-full px-4 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none select-none hover:text-foreground focus-visible:ring-4 focus-visible:ring-brand/25 data-active:text-foreground"
              >
                {t.label}
                {t.key === "overview" && state.attention.length > 0 ? (
                  <span className="ml-1.5 inline-grid size-[18px] place-items-center rounded-full bg-danger text-[11px] font-semibold text-white tabular-nums">
                    <span className="sr-only">, needs attention: </span>
                    {state.attention.length}
                  </span>
                ) : null}
              </Tabs.Tab>
            ))}
            <Tabs.Indicator className="absolute top-1 left-0 z-0 h-8 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-card shadow-sm transition-[translate,width] duration-200 ease-out" />
          </Tabs.List>
        </div>

        <div className="mt-6">
          <Tabs.Panel value="overview" className={PANEL}>
            <Overview state={state} onOpenBooking={openBooking} onSeeAll={() => changeTab("payments")} />
          </Tabs.Panel>
          <Tabs.Panel value="bookings" className={PANEL}>
            <BookingsTab rows={state.bookings} onOpen={(id) => openBooking(id)} />
          </Tabs.Panel>
          <Tabs.Panel value="calls" className={PANEL}>
            <CallsTab calls={state.calls} onOpen={openCall} />
          </Tabs.Panel>
          <Tabs.Panel value="payments" className={PANEL}>
            <PaymentsTab state={state} onOpenBooking={(id) => openBooking(id)} />
          </Tabs.Panel>
          <Tabs.Panel value="prices" className={PANEL}>
            <PriceListTab catalog={state.catalog} />
          </Tabs.Panel>
          <Tabs.Panel value="outbox" className={PANEL}>
            <OutboxTab outbox={state.outbox} onOpen={(id) => setEmail({ id, open: true })} />
          </Tabs.Panel>
        </div>
      </Tabs.Root>

      <BookingSheet
        target={booking.target}
        open={booking.open}
        onOpenChange={(open) => setBooking((b) => ({ ...b, open }))}
        rows={state.bookings}
        addons={state.catalog.addons}
        tick={tick}
        onNotify={notify}
        onChanged={() => void refresh()}
        onOpenCall={openCall}
      />
      <CallSheet
        callId={call.id}
        open={call.open}
        onOpenChange={(open) => setCall((c) => ({ ...c, open }))}
        tick={tick}
        onOpenBooking={(id) => openBooking(id)}
      />
      <EmailSheet emailId={email.id} open={email.open} onOpenChange={(open) => setEmail((m) => ({ ...m, open }))} />
      <NewActivity latest={state.ledger[0] ?? null} />

      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4" aria-live="polite">
        {toast ? (
          <p
            key={toast.id}
            role="status"
            className={cn(
              "pointer-events-auto flex max-w-md items-start gap-2 rounded-2xl px-4 py-3 text-[15px] shadow-sheet motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300",
              toast.tone === "danger" ? "bg-danger text-white" : "bg-foreground text-background",
            )}
          >
            {toast.tone === "success" ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#4ade80]" />
            ) : toast.tone === "danger" ? (
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0" />
            )}
            {toast.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One visually hidden status line for screen readers: the newest money step, said once when it arrives.
 * The lists themselves aren't live regions (their "2 min ago" labels change on every poll).
 */
function NewActivity({ latest }: { latest: { id: string; text: string } | null }) {
  const [seen, setSeen] = useState(latest?.id ?? null);
  const [said, setSaid] = useState("");
  const id = latest?.id ?? null;
  if (id !== seen) {
    setSeen(id);
    if (latest) setSaid(latest.text);
  }
  return (
    <p className="sr-only" role="status" aria-live="polite">
      {said}
    </p>
  );
}

function LiveBadge({ status }: { status: LiveStatus }) {
  const live = status === "live";
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-2 rounded-full px-3 text-xs font-medium",
        live ? "bg-success-soft text-success" : "bg-neutral-soft text-muted-foreground",
      )}
      title={live ? "Updates every few seconds" : undefined}
    >
      <span className="relative flex size-2">
        {live ? (
          <span className="absolute inline-flex size-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
        ) : null}
        <span className={cn("relative inline-flex size-2 rounded-full", live ? "bg-success" : "bg-muted-foreground")} />
      </span>
      {live ? "Live" : status === "gone" ? "Ended" : "Reconnecting…"}
    </span>
  );
}
