"use client";

import { useSyncExternalStore } from "react";

/** Tailwind's `lg` breakpoint: the pay panel sits beside the conversation from here up. */
const QUERY = "(min-width: 1024px)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * Whether the viewport is desktop-wide. False on the server and during hydration, so a component that
 * renders something only on one side (the pay panel) renders it exactly once, never in both places.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
