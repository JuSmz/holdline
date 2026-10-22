"use client";

import { cn } from "cn";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";

export type Identity = { firstName: string; email: string };

/** The first name as the agent will use it (the server keeps the first word, like `cleanFirstName`). */
export function displayName(identity: Identity): string {
  return identity.firstName.trim().split(/\s+/)[0]?.slice(0, 40) || "there";
}

/** The edited details, trimmed, if the server's form rules would take them (a first name, an email). */
function cleanIdentity(draft: Identity): Identity | null {
  const next = { firstName: draft.firstName.trim(), email: draft.email.trim() };
  const ok =
    next.firstName.length > 0 &&
    next.firstName.length <= 40 &&
    next.email.length <= 120 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email);
  return ok ? next : null;
}

export type IdentityState = {
  identity: Identity;
  /** The open "Change" form's values; null while it is closed. */
  draft: Identity | null;
  setDraft: (draft: Identity | null) => void;
  /**
   * The identity to start the conversation with. An open "Change" form counts as pressing Done (it is
   * saved and closed); null when its values aren't valid yet, so the form stays open.
   */
  commit: () => Identity | null;
};

/**
 * The identity shown on the chat and call pages, and its "Change" form. The parent owns both, so
 * starting the conversation uses what the visitor typed even if they never pressed Done.
 */
export function useIdentity(initial: Identity): IdentityState {
  const [identity, setIdentity] = useState(initial);
  const [draft, setDraft] = useState<Identity | null>(null);
  const commit = () => {
    if (!draft) return identity;
    const next = cleanIdentity(draft);
    if (!next) return null;
    setIdentity(next);
    setDraft(null);
    return next;
  };
  return { identity, draft, setDraft, commit };
}

/**
 * "You're chatting as Sam · sam@example.com · Change": the sample identity the agent uses, editable
 * inline until the conversation starts (then it is locked, since the server already has it).
 */
export function IdentityLine({
  state,
  locked,
  verb = "chatting",
  className,
}: {
  state: IdentityState;
  locked?: boolean;
  verb?: "chatting" | "calling";
  className?: string;
}) {
  const { identity, draft, setDraft } = state;
  const id = useId();

  if (draft && !locked) {
    return (
      <form
        className={cn("text-left", className)}
        aria-label="Your details"
        onSubmit={(event) => {
          event.preventDefault();
          state.commit();
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 basis-32" htmlFor={`${id}-name`}>
            <span className="mb-1 block text-xs font-medium text-muted-foreground">First name</span>
            <Input
              id={`${id}-name`}
              className="h-9 rounded-full px-3.5 text-base sm:text-sm"
              value={draft.firstName}
              maxLength={40}
              required
              autoComplete="given-name"
              autoFocus
              onChange={(e) => setDraft({ ...draft, firstName: e.target.value })}
            />
          </label>
          <label className="min-w-0 flex-[2] basis-48" htmlFor={`${id}-email`}>
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Email</span>
            <Input
              id={`${id}-email`}
              className="h-9 rounded-full px-3.5 text-base sm:text-sm"
              type="email"
              value={draft.email}
              maxLength={120}
              required
              autoComplete="email"
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            />
          </label>
          <div className="flex gap-1.5">
            <Button type="submit" size="sm" variant="dark">
              Done
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Made-up details are fine — this is a demo.</p>
      </form>
    );
  }

  return (
    <p className={cn("text-[13px] text-muted-foreground", className)}>
      You&apos;re {verb} as <span className="font-medium text-foreground">{displayName(identity)}</span>
      <span aria-hidden> · </span>
      <span className="sr-only">, </span>
      <span className="break-all">{identity.email}</span>
      {locked ? null : (
        <>
          <span aria-hidden> · </span>
          <button
            type="button"
            className="rounded font-medium text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand/40"
            aria-label="Change your name and email"
            onClick={() => setDraft(identity)}
          >
            Change
          </button>
        </>
      )}
    </p>
  );
}
