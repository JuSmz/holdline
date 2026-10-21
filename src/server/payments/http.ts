import { BookingInputError } from "@/server/domain/bookings";
import { InvoiceInputError } from "@/server/domain/pricing";
import { BookingNotFoundError, TransitionConflictError } from "@/server/domain/transition";
import { dbErrorCode } from "@/server/db-error";
import { PayPalApiError } from "@/server/paypal/errors";

import { PaymentStateError } from "./context";
import { DefiniteOperationError, OperationFailedError, OperationInProgressError } from "./ledger";

/**
 * Maps payment and booking errors to JSON responses for route handlers. Business refusals keep their
 * own message; anything unexpected is logged as a code only and answered generically.
 */
export function paymentErrorResponse(error: unknown): Response {
  const json = (status: number, code: string, message: string) =>
    Response.json({ ok: false, error: code, message }, { status });
  if (error instanceof PaymentStateError) return json(error.status, error.code, error.message);
  if (error instanceof TransitionConflictError) return json(409, "conflict", error.message);
  if (error instanceof BookingInputError) return json(error.status, error.code, error.message);
  if (error instanceof BookingNotFoundError) return json(404, "not_found", "Booking not found.");
  if (error instanceof InvoiceInputError) return json(400, "invalid_items", error.message);
  if (error instanceof OperationInProgressError) return json(202, "in_progress", error.message);
  if (error instanceof OperationFailedError) return json(409, "failed", error.message);
  if (error instanceof DefiniteOperationError) return json(409, "refused", error.message);
  if (error instanceof PayPalApiError) {
    return json(502, "paypal_error", `PayPal: ${error.issue ?? error.errorName ?? error.status}`);
  }
  console.error(`[holdline] payment route failed: ${dbErrorCode(error)}`);
  return json(500, "server_error", "Something went wrong.");
}
