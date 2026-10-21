import type { WorkspacePolicy } from "@/db/schema";

/** Defaults for SPEC §7 `workspaces.policy`. */
export const DEFAULT_POLICY: Required<WorkspacePolicy> = {
  cancellationWindowHours: 24,
  holdTtlMinutes: 60,
  staleHoldHours: 72,
  bookingWindowDays: 14,
};

/** The effective policy; the booking window never exceeds 14 days (§8.4.6 keeps holds inside 29 days). */
export function policyOf(policy: WorkspacePolicy | null | undefined): Required<WorkspacePolicy> {
  const merged = { ...DEFAULT_POLICY, ...(policy ?? {}) };
  return { ...merged, bookingWindowDays: Math.min(merged.bookingWindowDays, 14) };
}

const HOUR = 3_600_000;

/** A cancellation is late when it comes less than `cancellationWindowHours` before the slot (SPEC §9.5). */
export function isLateCancellation(policy: Required<WorkspacePolicy>, slotStart: Date, now: Date): boolean {
  return slotStart.getTime() - now.getTime() < policy.cancellationWindowHours * HOUR;
}
