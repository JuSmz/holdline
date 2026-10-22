import { cn } from "@/lib/utils";

/** Handset with a "pause" (hold) mark — Holdline's glyph. */
export function LogoGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-6", className)}>
      <rect width="32" height="32" rx="8" className="fill-foreground" />
      <path
        d="M10.2 8.5c.5-.5 1.3-.5 1.8 0l2 2c.5.5.5 1.3 0 1.8l-1.1 1.1c.8 1.8 2.2 3.2 4 4l1.1-1.1c.5-.5 1.3-.5 1.8 0l2 2c.5.5.5 1.3 0 1.8l-1.3 1.3c-.9.9-2.2 1.2-3.4.8-4-1.4-7.1-4.5-8.5-8.5-.4-1.2-.1-2.5.8-3.4l.8-.8Z"
        className="fill-background"
      />
      <rect x="20" y="7.5" width="1.9" height="6" rx=".95" className="fill-brand" />
      <rect x="23.4" y="7.5" width="1.9" height="6" rx=".95" className="fill-brand" />
    </svg>
  );
}

/** The glyph and the wordmark; `wordmarkClassName` can hide the word on narrow headers (keep an aria-label). */
export function Logo({ className, wordmarkClassName }: { className?: string; wordmarkClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <LogoGlyph />
      <span className={cn("text-lg", wordmarkClassName)}>holdline</span>
    </span>
  );
}
