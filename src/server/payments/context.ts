import { getDb } from "@/db/client";
import type { Db } from "@/db/types";
import { scheduleNotify } from "@/server/agent/notify";
import { getPayPalClient } from "@/server/paypal";
import type { PayPalClient } from "@/server/paypal/client";

/** What `notifyCall` (SPEC §16) announces mid-call or in the chat. */
export type CallNotice = "authorized" | "declined_retry" | "expired";

export type PaymentContext = {
  db: Db;
  paypal: PayPalClient;
  now: () => Date;
  /** Fire-and-forget hook after a booking reaches a notice state; never awaited for correctness. */
  notify: (bookingId: string, notice: CallNotice) => void;
};

/**
 * The production context: the shared pool, the sandbox (or fake) PayPal client, the wall clock, and
 * notifyCall after the response.
 */
export function defaultContext(overrides: Partial<PaymentContext> = {}): PaymentContext {
  let paypal: PayPalClient | undefined;
  return {
    db: getDb(),
    // Lazy: agent tools that never touch PayPal must work while PayPal isn't configured.
    get paypal() {
      return (paypal ??= getPayPalClient());
    },
    now: () => new Date(),
    notify: scheduleNotify,
    ...overrides,
  };
}

/**
 * The production context, or throws PayPalNotConfiguredError right away (for routes that degrade to
 * "not processed" instead of failing halfway through).
 */
export function configuredContext(overrides: Partial<PaymentContext> = {}): PaymentContext {
  const ctx = defaultContext(overrides);
  void ctx.paypal;
  return ctx;
}

/** A business rule refused the request (e.g. "this booking can't be paid any more"). */
export class PaymentStateError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code = "invalid_state",
  ) {
    super(message);
    this.name = "PaymentStateError";
  }
}
