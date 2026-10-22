"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const POLL_MS = 3_000;

export type LiveStatus = "live" | "offline" | "gone";

/**
 * Polls a JSON endpoint every 3 s while the page is visible (docs/design-system.md: the system moves on
 * its own), and once more as soon as the tab becomes visible again. Requests never overlap. Once the
 * endpoint answers 401 (the demo copy is gone) polling stops for good.
 */
export function useLive<T>(url: string, initial: T) {
  const [data, setData] = useState<T>(initial);
  const [status, setStatus] = useState<LiveStatus>("live");
  const [tick, setTick] = useState(0);
  const inFlight = useRef(false);
  const gone = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current || gone.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(url, { cache: "no-store", headers: { accept: "application/json" } });
      if (res.status === 401) {
        gone.current = true;
        setStatus("gone");
        return;
      }
      if (!res.ok) {
        setStatus("offline");
        return;
      }
      setData((await res.json()) as T);
      setStatus("live");
      setTick((t) => t + 1);
    } catch {
      setStatus("offline");
    } finally {
      inFlight.current = false;
    }
  }, [url]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      if (stopped || gone.current) return;
      if (document.visibilityState === "visible") await refresh();
      if (!stopped && !gone.current) timer = setTimeout(loop, POLL_MS);
    };
    timer = setTimeout(loop, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return { data, status, tick, refresh };
}

/**
 * A detail view (booking, call, email) fetched when it opens and again on every dashboard poll (`tick`),
 * so an open sheet updates in place too. While `enabled` is false (the sheet is closed) nothing is
 * fetched, but the last data stays for the closing animation. Data of a different URL is never shown.
 */
export function useDetail<T>(url: string | null, tick: number, enabled = true) {
  const [stored, setStored] = useState<{ url: string; data: T | null; missing: boolean } | null>(null);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    if (!url || !enabled) return;
    const controller = new AbortController();
    fetch(url, { cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal })
      .then(async (res) => {
        if (res.status === 404) setStored({ url, data: null, missing: true });
        else if (res.ok) setStored({ url, data: (await res.json()) as T, missing: false });
      })
      .catch(() => {
        // Offline for a moment: keep what is shown; the next poll tries again.
      });
    return () => controller.abort();
  }, [url, tick, bump, enabled]);

  const current = stored && stored.url === url ? stored : null;
  return {
    data: current?.data ?? null,
    missing: current?.missing ?? false,
    reload: useCallback(() => setBump((b) => b + 1), []),
  };
}
