"use client";

import { useEffect, useRef } from "react";

/**
 * Polls `poll` every `ms` while `active`, one request at a time, and only while the tab is visible
 * (a hidden tab skips ticks and catches up the moment it is shown again). When `active` turns false
 * it polls `linger` more times, so a server line that lands right after a final state still shows,
 * then stops until `active` is true again. Errors are swallowed: the next tick retries.
 */
export function usePoll(poll: () => Promise<unknown>, active: boolean, { ms = 1500, linger = 0 } = {}) {
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  });

  useEffect(() => {
    let budget = active ? Number.POSITIVE_INFINITY : linger;
    if (budget <= 0) return;
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      timer = undefined;
      if (stopped || inFlight || budget <= 0) return;
      // Hidden: no request and no new timer; the visibilitychange listener resumes the loop.
      if (document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        await pollRef.current();
      } catch {
        // Offline for a moment: the next tick catches up.
      } finally {
        inFlight = false;
      }
      budget -= 1;
      if (!stopped && budget > 0) timer = setTimeout(tick, ms);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && timer === undefined) void tick();
    };

    timer = setTimeout(tick, ms);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, linger, ms]);
}
