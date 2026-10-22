"use client";

import { Notice } from "@/components/ui/notice";
import { Sheet } from "@/components/ui/sheet";
import { Pill } from "@/components/ui/status-pill";
import type { LineTone } from "@/server/dashboard/wording";

import { useDetail } from "./use-live";

type EmailJson = {
  ok: true;
  id: string;
  subject: string;
  ref: string | null;
  atLabel: string;
  status: { label: string; tone: LineTone };
  html: string;
};

/** One outbox email, rendered in a sandboxed frame: no scripts, no same-origin, links open a new tab. */
export function EmailSheet({
  emailId,
  open,
  onOpenChange,
}: {
  emailId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // The email itself never changes: fetched once per open (tick 0).
  const { data: email, missing } = useDetail<EmailJson>(emailId ? `/api/dashboard/outbox/${emailId}` : null, 0);
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={email?.subject ?? "Email"}
      description={email ? [email.ref, email.atLabel].filter(Boolean).join(" · ") : undefined}
    >
      {missing ? (
        <Notice tone="neutral">This email isn&apos;t in your demo copy any more.</Notice>
      ) : !email ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-3 pb-4">
          <Pill tone={email.status.tone}>{email.status.label}</Pill>
          <iframe
            title={email.subject}
            // No scripts, no same-origin; links may open a new tab (the pay page runs there).
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={email.html}
            className="h-[65dvh] w-full rounded-2xl border border-border bg-white"
          />
        </div>
      )}
    </Sheet>
  );
}
