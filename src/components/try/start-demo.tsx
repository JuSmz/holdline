"use client";

import { LoaderCircle } from "lucide-react";
import { useActionState } from "react";

import { type StartState, startDemo } from "@/app/(app)/try/actions";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

/** "Start the demo": a Server Action POST (with Next's Origin check); GET /try never creates anything. */
export function StartDemo() {
  const [state, action, pending] = useActionState<StartState, FormData>(startDemo, { error: null });
  return (
    <form action={action}>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? (
          <>
            <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> Setting up your copy…
          </>
        ) : (
          "Start the demo"
        )}
      </Button>
      {state.error ? (
        <Notice tone="danger" className="mt-3">
          {state.error}
        </Notice>
      ) : null}
    </form>
  );
}
