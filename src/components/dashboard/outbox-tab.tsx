"use client";

import { ChevronRight, Mail } from "lucide-react";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/status-pill";

import type { State } from "./shared";

/** Every email Holdline rendered for this demo copy, including those shown here only. */
export function OutboxTab({ outbox, onOpen }: { outbox: State["outbox"]; onOpen: (id: string) => void }) {
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-[15px] text-muted-foreground">
        The emails your customers would get. In this demo they stay here — nothing goes to a real inbox.
      </p>
      {outbox.length === 0 ? (
        <Card>
          <EmptyState icon={Mail} title="No emails yet">
            The pay link, the confirmation and receipts appear here as the booking moves along.
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {outbox.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onOpen(m.id)}
                  className="flex w-full items-center gap-4 px-4 py-3.5 text-left transition-colors hover:bg-canvas focus-visible:ring-4 focus-visible:ring-brand/25 focus-visible:outline-none focus-visible:ring-inset sm:px-6"
                >
                  <span
                    aria-hidden
                    className="grid size-10 shrink-0 place-items-center rounded-full bg-neutral-soft text-muted-foreground"
                  >
                    <Mail className="size-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{m.subject}</span>
                    <span className="block truncate text-sm text-muted-foreground">{m.atLabel}</span>
                  </span>
                  <span className="hidden shrink-0 sm:block">
                    <Pill tone={m.status.tone}>{m.status.label}</Pill>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
