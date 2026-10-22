import { DEMO_STEPS, Steps } from "@/components/ui/steps";

/** The three demo steps; compact ("Step 2 of 3 · …") on phones, where the full row would wrap. */
export function FlowSteps({ current, className }: { current: 1 | 2 | 3; className?: string }) {
  return (
    <div className={className}>
      <Steps current={current} className="hidden sm:flex" />
      <p className="text-[13px] text-muted-foreground sm:hidden" aria-live="polite">
        Step {current} of 3 · <span className="font-medium text-foreground">{DEMO_STEPS[current - 1]}</span>
      </p>
    </div>
  );
}
