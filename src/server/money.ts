/** Money is integer cents everywhere; PayPal wants decimal strings with two places. */

export type Currency = "USD";

/** 14900 -> "149.00". Integer math only. */
export function centsToPayPal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`invalid amount in cents: ${cents}`);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

/** "149.00" / "149" / "149.5" -> 14900 / 14900 / 14950. Rejects anything else. */
export function payPalToCents(value: string): number {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`invalid PayPal amount: ${value}`);
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? "").padEnd(2, "0"));
  return whole * 100 + frac;
}

/** "$149.00" for display. */
export function formatUsd(cents: number): string {
  return `$${centsToPayPal(cents)}`;
}
