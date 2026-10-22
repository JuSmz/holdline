"use client";

import { ChevronRight, Headphones, MessageCircle, Phone, PhoneOff } from "lucide-react";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill, StatusPill } from "@/components/ui/status-pill";

import { SampleTag, type State } from "./shared";

const CHANNEL = {
  chat: { label: "Chat", icon: MessageCircle },
  web: { label: "Web call", icon: Headphones },
  phone: { label: "Phone call", icon: Phone },
} as const;

/** Every conversation of this demo copy, newest first; a row opens the call sheet. */
export function CallsTab({ calls, onOpen }: { calls: State["calls"]; onOpen: (id: string) => void }) {
  if (calls.length === 0) {
    return (
      <Card>
        <EmptyState icon={PhoneOff} title="No conversations yet">
          Chat with the AI receptionist or call it in your browser. Each conversation appears here.
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border">
        {calls.map((c) => {
          const channel = CHANNEL[c.channel] ?? CHANNEL.web;
          const Icon = channel.icon;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                className="flex w-full items-center gap-4 px-4 py-3.5 text-left transition-colors hover:bg-canvas focus-visible:ring-4 focus-visible:ring-brand/25 focus-visible:outline-none focus-visible:ring-inset sm:px-6"
              >
                <span
                  aria-hidden
                  className="grid size-10 shrink-0 place-items-center rounded-full bg-neutral-soft text-muted-foreground"
                >
                  <Icon className="size-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[15px] font-medium">{c.title}</span>
                    {c.sample ? <SampleTag /> : null}
                  </span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {[channel.label, c.atLabel, c.duration].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="hidden shrink-0 sm:block">
                  {c.bookingStatus ? (
                    <StatusPill status={c.bookingStatus} flag={c.bookingFlag} />
                  ) : (
                    <Pill tone={c.live ? "brand" : "neutral"}>{c.outcome}</Pill>
                  )}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
