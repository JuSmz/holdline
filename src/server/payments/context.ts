import { getDb } from "@/db/client";
import type { Db } from "@/db/types";
import { getPayPalClient } from "@/server/paypal";
import type { PayPalClient } from "@/server/paypal/client";

/** What `notifyCall` (SPEC §16) announces mid-call. Stage 8 wires the voice and chat delivery. */
export type CallNotice = "authorized" | "declined_retry" | "expired";

export type PaymentContext = {
  db: Db;
  paypal: PayPalClient;
  now: () => Date;
  /** Fire-and-forget hook after a booking reaches a notice state; never awaited for correctness. */
  notify: (bookingId: string, notice: CallNotice) => void;
};

/** The production context: the shared pool, the sandbox (or fake) PayPal client, the wall clock. */
export function defaultContext(overrides: Partial<PaymentContext> = {}): PaymentContext {
  return {
    db: getDb(),
    paypal: getPayPalClient(),
    now: () => new Date(),
    notify: () => {},
    ...overrides,
  };
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
