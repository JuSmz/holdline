import { cn } from "cn";
import { Check } from "lucide-react";

export const DEMO_STEPS = ["Book as a customer", "Approve the PayPal hold", "Finish as the owner"] as const;

/** The three demo steps, with the current one highlighted. */
export function Steps({ current, className }: { current: 1 | 2 | 3; className?: string }) {
  return (
    <ol className={cn("flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px]", className)} aria-label="Demo steps">
      {DEMO_STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "current" : "upcoming";
        return (
          <li key={label} className="flex items-center gap-2" aria-current={state === "current" ? "step" : undefined}>
            <span
              className={cn(
                "grid size-5 place-items-center rounded-full text-[11px] font-semibold",
                state === "done" && "bg-success text-white",
                state === "current" && "bg-brand text-white",
                state === "upcoming" && "bg-neutral-soft text-muted-foreground",
              )}
            >
              {state === "done" ? <Check className="size-3" strokeWidth={3} /> : n}
            </span>
            <span className={cn(state === "upcoming" ? "text-muted-foreground" : "font-medium text-foreground")}>
              {label}
            </span>
            {n < DEMO_STEPS.length ? <span aria-hidden className="mx-1 h-px w-6 bg-border" /> : null}
          </li>
        );
      })}
    </ol>
  );
}
