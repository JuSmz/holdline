/**
 * The customer-facing pay-panel states (SPEC §16) and the demo step they put the visitor on. A plain
 * module (no database, no "use client"), shared by the server pages and the call, chat and pay panels.
 */

export type PanelState =
  | "waiting"
  | "processing"
  | "declined_retry"
  | "reapprove"
  | "authorized"
  | "done"
  | "late_cancel"
  | "no_show"
  | "fee_pending"
  | "missed"
  | "cancelled"
  | "expired";

/** Panel states in which the buyer still has to act (or PayPal is still deciding). */
export const NEEDS_BUYER: ReadonlySet<PanelState> = new Set<PanelState>([
  "waiting",
  "processing",
  "declined_retry",
  "reapprove",
]);

/** Where the visitor is in the demo: ① book (nothing yet, or it expired), ② approve the hold, ③ finish as the owner. */
export function demoStep(panel: PanelState | null): 1 | 2 | 3 {
  if (!panel || panel === "expired") return 1;
  return NEEDS_BUYER.has(panel) ? 2 : 3;
}
