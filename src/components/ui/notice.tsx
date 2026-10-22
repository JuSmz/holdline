import { cn } from "cn";
import type { ReactNode } from "react";

import type { Tone } from "./status-pill";

const TONES: Record<Tone | "info", string> = {
  info: "bg-canvas text-foreground",
  brand: "bg-brand-soft text-brand",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  neutral: "bg-neutral-soft text-muted-foreground",
};

/** An inline status line, announced to screen readers. */
export function Notice({
  tone = "info",
  children,
  className,
}: {
  tone?: Tone | "info";
  children: ReactNode;
  className?: string;
}) {
  return (
    <p role="status" className={cn("rounded-2xl px-4 py-3 text-sm", TONES[tone], className)}>
      {children}
    </p>
  );
}
