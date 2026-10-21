/**
 * The booking state machine (SPEC §8) as pure data. The database trigger in
 * drizzle/0004_status_guards.sql encodes the same pairs; a test keeps them in sync.
 */

export const BOOKING_STATUSES = [
  "pending_payment",
  "authorized",
  "completed",
  "no_show",
  "cancelled",
  "captured",
  "voided",
  "expired",
  "paid_out",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const PAYMENT_ISSUES = [
  "authorization_pending",
  "reauth_failed",
  "hold_lost",
  "capture_failed",
  "capture_pending",
  "payout_failed",
] as const;
export type PaymentIssue = (typeof PAYMENT_ISSUES)[number];

/** §8.1: every transition strictly increases the rank. */
export const STATUS_RANK: Record<BookingStatus, number> = {
  pending_payment: 0,
  authorized: 1,
  completed: 2,
  no_show: 2,
  cancelled: 2,
  captured: 3,
  voided: 3,
  expired: 3,
  paid_out: 4,
};

/** §8.2: the only allowed transitions. */
export const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  pending_payment: ["authorized", "expired"],
  authorized: ["completed", "no_show", "cancelled"],
  completed: ["captured"],
  no_show: ["captured", "voided"],
  cancelled: ["voided", "captured"],
  captured: ["paid_out"],
  voided: [],
  expired: [],
  paid_out: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: BookingStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** §8.3: the statuses in which each flag may be set. A flag not allowed in a new status is cleared on the way. */
export const FLAG_STATUSES: Record<PaymentIssue, readonly BookingStatus[]> = {
  authorization_pending: ["pending_payment"],
  reauth_failed: ["authorized"],
  hold_lost: ["authorized"],
  capture_failed: ["completed", "no_show", "cancelled", "captured"],
  capture_pending: ["captured"],
  payout_failed: ["captured"],
};

export function canSetFlag(status: BookingStatus, flag: PaymentIssue): boolean {
  return FLAG_STATUSES[flag].includes(status);
}

/** The flags that survive a move into `status`. */
export function flagsAllowedIn(status: BookingStatus): PaymentIssue[] {
  return PAYMENT_ISSUES.filter((flag) => canSetFlag(status, flag));
}

/** Statuses in which the booking's slot is held (§8.4.5). `pending_payment` holds only within its TTL. */
export const SLOT_HOLDING_STATUSES: readonly BookingStatus[] = ["pending_payment", "authorized", "cancelled"];

/** What the losing click of a sibling race is told (§8.4.2): no fake success. */
const ALREADY: Record<BookingStatus, string> = {
  pending_payment: "This booking is not authorized yet.",
  authorized: "This booking is already authorized.",
  completed: "Already marked as job done.",
  no_show: "Already marked as no-show.",
  cancelled: "This booking is already cancelled.",
  captured: "The payment for this booking is already captured.",
  voided: "The hold for this booking is already released.",
  expired: "This booking has already expired.",
  paid_out: "This booking is already paid out.",
};

export function conflictMessage(current: BookingStatus): string {
  return ALREADY[current];
}
