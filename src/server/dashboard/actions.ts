import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { addonItems, payouts, technicians } from "@/db/schema";
import { isLateCancellation, policyOf } from "@/server/domain/policy";
import { type Booking, lockBooking, setPaymentIssue } from "@/server/domain/transition";
import { InvoiceInputError } from "@/server/domain/pricing";
import { markJobDone, markNoShow, type MoneyOutcome, retryCapture } from "@/server/payments/capture";
import { type PaymentContext, PaymentStateError } from "@/server/payments/context";
import { billExtraWork, billViaInvoice, type InvoiceRow } from "@/server/payments/invoices";
import { retryPayout } from "@/server/payments/payouts";
import { getBooking } from "@/server/payments/queries";
import { cancelBooking, waiveFee } from "@/server/payments/void";
import type { Workspace } from "@/server/workspaces/guard";

import { firstName, usd } from "./format";
import { schedulePayouts } from "./payouts";

/**
 * The owner's booking actions (SPEC §18), shared by the dashboard route. The logic follows the lab route
 * (src/app/api/lab/bookings/[id]/action) and goes straight through the payment services, which keep every
 * guarantee: amounts from the booking snapshot only, the ledger, CAS transitions, sibling conflicts.
 */

export const ACTION_KEYS = [
  "job_done",
  "no_show",
  "cancel",
  "waive_fee",
  "extra_work",
  "retry_capture",
  "bill_via_invoice",
  "retry_payout",
] as const;
export type ActionKey = (typeof ACTION_KEYS)[number];

export const MAX_EXTRA_WORK_LINES = 6;

export const actionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("job_done") }),
  z.object({ action: z.literal("no_show") }),
  z.object({
    action: z.literal("cancel"),
    /** The rule the owner confirmed in the dialog (late fee or free); refused if it no longer holds. */
    expectLate: z.boolean().optional(),
  }),
  z.object({ action: z.literal("waive_fee") }),
  z.object({ action: z.literal("retry_capture") }),
  z.object({ action: z.literal("bill_via_invoice") }),
  z.object({
    action: z.literal("retry_payout"),
    /** The payout the dialog showed (amount and technician): only that one is sent again. */
    payoutId: z.uuid(),
  }),
  z.object({
    action: z.literal("extra_work"),
    /** Add-on keys and quantities only: the price of each line comes from the catalog. */
    items: z
      .array(
        z.object({
          addonKey: z.string().regex(/^[a-z0-9-]{1,40}$/),
          quantity: z.number().int().min(1).max(20),
        }),
      )
      .min(1)
      .max(MAX_EXTRA_WORK_LINES),
  }),
]);
export type ActionInput = z.infer<typeof actionInput>;

const DAY = 24 * 3_600_000;
/** Extra work can be billed within 14 days of the visit (SPEC §9.6). */
export const EXTRA_WORK_DAYS = 14;

/** What availability depends on, gathered per booking by the queries. */
export type AvailabilityFacts = {
  status: string;
  flag: string | null;
  sample: boolean;
  cancelReason: string | null;
  slotEnd: Date;
  /** The owner marked the job done (so extra work makes sense, unlike after a no-show fee). */
  jobDone: boolean;
  /** A capture (any kind, any retry) is unresolved in the ledger. */
  captureInFlight: boolean;
  /** Any payment operation of this booking is unresolved in the ledger. */
  anyInFlight: boolean;
  /** A fallback invoice that isn't cancelled exists: Retry capture is off for good (SPEC §9.7). */
  fallbackInvoice: boolean;
  /** The newest attempt of some payout of this booking is failed or unclaimed. */
  retryablePayout: boolean;
};

/**
 * The actions the owner can take right now, primary first (docs/design-system.md: one blue primary).
 * The payment services re-check everything; this only decides which buttons the page shows.
 */
export function availableActions(f: AvailabilityFacts, now: Date): ActionKey[] {
  if (f.sample) return [];
  const actions: ActionKey[] = [];
  const failed = f.flag === "capture_failed";
  const feeCase = f.status === "no_show" || (f.status === "cancelled" && f.cancelReason === "late");
  switch (f.status) {
    case "pending_payment":
      if (!f.flag) actions.push("cancel");
      break;
    case "authorized":
      // A lost or failed-renewal hold can't be charged: the customer approves again first (SPEC §9.8).
      if (f.flag === "hold_lost" || f.flag === "reauth_failed") actions.push("cancel");
      else actions.push("job_done", "no_show", "cancel");
      break;
    case "completed":
    case "no_show":
    case "cancelled":
      if (failed && !f.captureInFlight && !f.fallbackInvoice) actions.push("retry_capture", "bill_via_invoice");
      if (feeCase && !f.captureInFlight && !f.fallbackInvoice) actions.push("waive_fee");
      // A free cancellation whose release didn't go through: releasing again is safe (same ledger key).
      if (f.status === "cancelled" && !feeCase && !f.anyInFlight) actions.push("cancel");
      break;
    case "captured":
    case "paid_out":
      if (f.retryablePayout) actions.push("retry_payout");
      if (failed && !f.captureInFlight && !f.fallbackInvoice) actions.push("bill_via_invoice");
      if (f.jobDone && now.getTime() <= f.slotEnd.getTime() + EXTRA_WORK_DAYS * DAY) actions.push("extra_work");
      break;
  }
  return actions;
}

export type ActionResult = {
  ok: true;
  outcome: string;
  bookingStatus: string;
  flag: string | null;
  /** One plain-English sentence for the page (docs/design-system.md). */
  message: string;
  invoice?: { number: string; status: string; totalCents: number };
};

/**
 * Cancel says what it costs before it runs (SPEC §18). A cancel of an approved hold must carry the rule
 * the owner confirmed (`expectLate`); one without it came from the "Withdraw" dialog ($0.00, no hold),
 * so if the customer approved the hold meanwhile it is refused rather than charging a fee nobody saw.
 * Returns the refusal, or null when the cancel may run. The window crossing is re-checked here too.
 */
export function cancelRefusal(
  ws: Workspace,
  booking: Booking,
  input: ActionInput,
  now: Date,
): { error: string; message: string } | null {
  if (input.action !== "cancel") return null;
  if (input.expectLate === undefined) {
    if (booking.status === "authorized") {
      return {
        error: "rule_changed",
        message: "The customer just approved the hold. Check the cancellation rule and try again.",
      };
    }
    if (booking.status === "pending_payment" && booking.authorizingUntil && booking.authorizingUntil > now) {
      return {
        error: "rule_changed",
        message: "The customer is approving the hold right now. Try again in a moment.",
      };
    }
    return null;
  }
  if (booking.status !== "authorized") return null;
  const late = isLateCancellation(policyOf(ws.policy), booking.slotStart, now);
  if (late === input.expectLate) return null;
  return {
    error: "rule_changed",
    message: late
      ? "It's now inside the cancellation window, so the late fee applies. Check the new amount and try again."
      : "The cancellation rule changed since the dialog opened. Check it and try again.",
  };
}

/** The payment services' invoice checks, as sentences for the owner. */
function plainInvoiceError(error: unknown): never {
  if (!(error instanceof InvoiceInputError)) throw error;
  const known: Record<string, string> = {
    "total out of range": "That's more than one invoice can hold ($2,000). Lower a quantity and try again.",
    "pick 1–10 add-ons": "Pick at least one add-on.",
    "unknown add-on": "One of those add-ons isn't on your price list any more.",
    "each add-on only once": "Pick each add-on once.",
    "quantity must be 1–20": "Each quantity has to be between 1 and 20.",
  };
  throw new InvoiceInputError(known[error.message] ?? error.message);
}

/**
 * Runs one owner action on a (non-sample) booking of `ws`. Business refusals are thrown as payment
 * errors (the route maps them with paymentErrorResponse). After money is recognised the technician's
 * payout is sent right away, after the response.
 */
export async function runDashboardAction(
  ctx: PaymentContext,
  ws: Workspace,
  booking: Booking,
  input: ActionInput,
): Promise<ActionResult> {
  if (booking.sample) throw new PaymentStateError("Sample history is read-only.", 409, "sample");
  const db = ctx.db;
  const [tech] = await db
    .select({ name: technicians.name })
    .from(technicians)
    .where(eq(technicians.id, booking.technicianId));
  const techName = firstName(tech?.name);

  const money = (outcome: MoneyOutcome, charged: string): ActionResult => {
    const base = summary(outcome);
    if (outcome.status === "captured" && !outcome.booking.paymentIssue) {
      schedulePayouts(ctx, booking.id);
    }
    const message =
      outcome.status === "captured"
        ? outcome.booking.paymentIssue === "capture_pending"
          ? "PayPal is confirming the charge…"
          : `${charged} ${techName}'s payout is on its way.`
        : outcome.status === "capture_pending"
          ? "PayPal is confirming the charge…"
          : outcome.status === "capture_failed"
            ? "PayPal declined the charge. Retry it, or bill by invoice."
            : outcome.status === "voided"
              ? "The hold is released. Nothing was charged."
              : "PayPal is still working on it…";
    return { ...base, message };
  };

  switch (input.action) {
    case "job_done":
      return money(await markJobDone(ctx, booking.id), `Charged ${usd(booking.priceCents)}.`);
    case "no_show": {
      const outcome = await markNoShow(ctx, booking.id);
      if (outcome.status === "voided") {
        return {
          ...summary(outcome),
          message: "Marked no-show. There's no fee for this service, so the hold is released.",
        };
      }
      return money(outcome, `No-show fee charged · ${usd(booking.noShowFeeCents)}. The rest of the hold is released.`);
    }
    case "cancel": {
      // The status this request was checked against: a hold approved in between is a 409, not a fee.
      const outcome = await cancelBooking(ctx, booking.id, "owner", booking.status);
      if (outcome.rule === "withdrawn") {
        return { ...summary(outcome), message: "Booking withdrawn. No hold was placed, so nothing was charged." };
      }
      if (outcome.rule === "free_void") {
        return {
          ...summary(outcome),
          message:
            outcome.status === "voided"
              ? "Cancelled. The hold is released — nothing was charged."
              : "Cancelled. PayPal is releasing the hold…",
        };
      }
      return money(
        outcome,
        `Cancelled late. The ${usd(outcome.amountCents)} fee is charged and the rest of the hold released.`,
      );
    }
    case "waive_fee": {
      const outcome = await waiveFee(ctx, booking.id);
      return {
        ...summary(outcome),
        message: outcome.status === "voided" ? "Fee waived. The hold is released." : "PayPal is releasing the hold…",
      };
    }
    case "retry_capture": {
      const amount = booking.status === "completed" ? booking.priceCents : booking.noShowFeeCents;
      return money(await retryCapture(ctx, booking.id), `Charged ${usd(amount)}.`);
    }
    case "bill_via_invoice": {
      const invoice = await billViaInvoice(ctx, booking.id);
      return invoiceResult(ctx, booking.id, invoice, "The customer pays it on PayPal.");
    }
    case "extra_work": {
      const keys = input.items.map((i) => i.addonKey);
      if (new Set(keys).size !== keys.length) throw new InvoiceInputError("Pick each add-on once.");
      const rows = await db
        .select({ id: addonItems.id, key: addonItems.key })
        .from(addonItems)
        .where(and(eq(addonItems.workspaceId, ws.id), inArray(addonItems.key, keys), eq(addonItems.active, true)));
      const idOf = new Map(rows.map((r) => [r.key, r.id]));
      if (rows.length !== keys.length) {
        throw new InvoiceInputError("One of those add-ons isn't on your price list any more.");
      }
      const invoice = await billExtraWork(
        ctx,
        booking.id,
        input.items.map((i) => ({ addonId: idOf.get(i.addonKey)!, quantity: i.quantity })),
      ).catch(plainInvoiceError);
      return invoiceResult(ctx, booking.id, invoice, "The customer gets a PayPal invoice for the extra work.");
    }
    case "retry_payout": {
      // Exactly the payout the dialog showed, and only while it is the newest failed/unclaimed attempt.
      const retryable = await retryableOf(ctx, booking.id);
      if (!retryable.some((p) => p.id === input.payoutId)) {
        throw new PaymentStateError(
          "That payout isn't waiting for a retry any more. Check the booking.",
          409,
          "payout_not_failed",
        );
      }
      const row = await retryPayout(ctx, input.payoutId);
      await keepPayoutFlag(ctx, booking.id);
      const fresh = await currentBooking(ctx, booking.id);
      const amount = usd(row.amountCents);
      return {
        ok: true,
        outcome: row.status,
        bookingStatus: fresh.status,
        flag: fresh.paymentIssue,
        message:
          row.status === "succeeded"
            ? `${techName} is paid · ${amount}.`
            : row.status === "failed" || row.status === "unclaimed" || row.status === "needs_review"
              ? `PayPal didn't accept the payout to ${techName} (${amount}). Check the technician's payout email.`
              : `Payout sent again · ${techName} · ${amount}.`,
      };
    }
  }
}

function summary(outcome: MoneyOutcome) {
  return {
    ok: true as const,
    outcome: outcome.status,
    bookingStatus: outcome.booking.status,
    flag: outcome.booking.paymentIssue,
  };
}

const currentBooking = (ctx: PaymentContext, bookingId: string) => getBooking(ctx.db, bookingId);

async function invoiceResult(
  ctx: PaymentContext,
  bookingId: string,
  invoice: InvoiceRow,
  tail: string,
): Promise<ActionResult> {
  const fresh = await currentBooking(ctx, bookingId);
  return {
    ok: true,
    outcome: `invoice_${invoice.status}`,
    bookingStatus: fresh.status,
    flag: fresh.paymentIssue,
    message:
      invoice.status === "sent"
        ? `Invoice sent · ${usd(invoice.totalCents)}. ${tail}`
        : `Invoice prepared · ${usd(invoice.totalCents)}. PayPal is still sending it…`,
    invoice: { number: invoice.invoiceNumber, status: invoice.status, totalCents: invoice.totalCents },
  };
}

type PayoutLite = Pick<
  typeof payouts.$inferSelect,
  "id" | "source" | "sourceId" | "technicianId" | "attemptNo" | "status"
>;

/** The newest attempt per (source, technician), when it failed or went unclaimed (SPEC §9.9.4). */
export function retryablePayouts<T extends PayoutLite>(rows: T[]): T[] {
  const newest = new Map<string, T>();
  for (const r of rows) {
    const key = `${r.source}:${r.sourceId}:${r.technicianId}`;
    if ((newest.get(key)?.attemptNo ?? 0) < r.attemptNo) newest.set(key, r);
  }
  return [...newest.values()].filter((r) => r.status === "failed" || r.status === "unclaimed");
}

/** This booking's retryable payouts, oldest first: the same order the dashboard shows them in. */
async function retryableOf(ctx: PaymentContext, bookingId: string) {
  const rows = await ctx.db
    .select()
    .from(payouts)
    .where(and(eq(payouts.bookingId, bookingId), eq(payouts.sample, false)))
    .orderBy(asc(payouts.createdAt), asc(payouts.attemptNo), asc(payouts.id));
  return retryablePayouts(rows);
}

/**
 * retryPayout clears `payout_failed` for the whole booking; while another payout of it still waits for a
 * retry, the flag goes back on, so the booking stays under Needs attention.
 */
async function keepPayoutFlag(ctx: PaymentContext, bookingId: string): Promise<void> {
  if ((await retryableOf(ctx, bookingId)).length === 0) return;
  await ctx.db.transaction(async (tx) => {
    const b = await lockBooking(tx, bookingId);
    // The flag exists in `captured` only (as in flagPayoutFailed); a paid-out booking needs none.
    if (b.status === "captured" && b.paymentIssue === null) {
      await setPaymentIssue(tx, { bookingId, flag: "payout_failed", actor: "system", reason: "payout_still_failed" });
    }
  });
}
