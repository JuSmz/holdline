"use client";

import { useActionState } from "react";

import { type StartState, startDemo } from "@/app/(app)/try/actions";
import { Button } from "@/components/ui/button";

export function StartDemo() {
  const [state, action, pending] = useActionState<StartState, FormData>(startDemo, { error: null });
  return (
    <form action={action} className="space-y-3">
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Setting up your copy…" : "Start the demo"}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <p className="text-sm text-muted-foreground">
        Creates your own private copy of Northside Plumbing &amp; Electric with sample history. PayPal runs in sandbox
        mode: no real money moves.
      </p>
    </form>
  );
}
