/**
 * Small in-process fixed-window limiter for low-volume endpoints (owner login in stage 2).
 * The DB-backed atomic limiter with global caps (SPEC §20) replaces it in stage 8.
 */
export class MemoryRateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true if the call is allowed and counts it. */
  take(key: string): boolean {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: now, count: 1 });
      if (this.hits.size > 10_000) this.hits.clear();
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }
}
