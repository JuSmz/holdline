import { usd } from "./format";

/**
 * Plain-English lines for the owner (docs/design-system.md, "Activity lines"). Never a status enum,
 * a PayPal state or a reason code: every line reads like a sentence a person would say.
 */

export type LineTone = "neutral" | "brand" | "success" | "warning" | "danger";
/** What the line is about; the page picks the icon from it. */
export type LineKind = "booking" | "hold" | "charge" | "release" | "payout" | "invoice" | "problem" | "done";

export type Line = { text: string; tone: LineTone; kind: LineKind };

type EventLike = {
  fromStatus: string | null;
  toStatus: string | null;
  flag: string | null;
  reason: string | null;
  detail: Record<string, unknown> | null;
};

type BookingLike = { priceCents: number; noShowFeeCents: number };

const amountOf = (e: EventLike, fallback: number) =>
  typeof e.detail?.amountCents === "number" ? (e.detail.amountCents as number) : fallback;

/** One booking event (status change, flag change or note) as a line, or null when it says nothing new. */
export function eventLine(e: EventLike, b: BookingLike): Line | null {
  const pair = `${e.fromStatus ?? "new"}>${e.toStatus ?? ""}`;
  const added = /(^|\s)\+(\w+)/.exec(e.flag ?? "")?.[2] ?? null;
  const removed = /(^|\s)-(\w+)/.exec(e.flag ?? "")?.[2] ?? null;

  if (e.toStatus) {
    switch (pair) {
      case "new>pending_payment":
        return {
          text: "Booked · PayPal hold requested",
          tone: "neutral",
          kind: "booking",
        };
      case "pending_payment>authorized":
        return { text: `PayPal hold approved · ${usd(b.priceCents)}`, tone: "brand", kind: "hold" };
      case "pending_payment>expired":
        return {
          text:
            e.reason === "withdrawn"
              ? "Withdrawn before payment · nothing charged"
              : e.reason === "superseded"
                ? "Replaced by a newer booking"
                : "Approval window closed · no hold placed",
          tone: "neutral",
          kind: "release",
        };
      case "authorized>completed":
        return { text: "Marked job done", tone: "neutral", kind: "done" };
      case "authorized>no_show":
        return { text: "Marked no-show", tone: "neutral", kind: "done" };
      case "authorized>cancelled":
        return {
          text:
            e.reason === "late"
              ? `Cancelled late · ${usd(b.noShowFeeCents)} fee applies`
              : e.reason === "hold_timeout"
                ? "Hold timed out · released automatically"
                : "Cancelled · free cancellation",
          tone: "neutral",
          kind: "booking",
        };
      case "completed>captured":
      case "no_show>captured":
      case "cancelled>captured": {
        if (e.reason === "fallback_invoice_paid") {
          return { text: "Paid by invoice", tone: "success", kind: "invoice" };
        }
        const pending = added === "capture_pending";
        const what =
          e.fromStatus === "completed" ? null : e.fromStatus === "no_show" ? "No-show fee" : "Late-cancellation fee";
        const amount = usd(amountOf(e, e.fromStatus === "completed" ? b.priceCents : b.noShowFeeCents));
        if (pending) {
          return { text: `${what ?? "Charge"} pending at PayPal · ${amount}`, tone: "warning", kind: "charge" };
        }
        return {
          text: what ? `${what} charged · ${amount}` : `Charged ${amount}`,
          tone: "success",
          kind: "charge",
        };
      }
      case "no_show>voided":
      case "cancelled>voided":
        return {
          text:
            e.reason === "fee_waived"
              ? "Fee waived · hold released"
              : e.reason === "no_fee"
                ? "Hold released · no fee for this service"
                : "Hold released · nothing charged",
          tone: "neutral",
          kind: "release",
        };
      case "captured>paid_out":
        return { text: "Technician paid out", tone: "success", kind: "payout" };
      default:
        return null;
    }
  }

  // Flag-only changes and notes.
  if (added === "payout_failed" && e.reason === "payout_still_failed") {
    return { text: "Another technician payout still needs a retry", tone: "danger", kind: "problem" };
  }
  if (added) {
    const text: Record<string, string> = {
      capture_failed: "PayPal declined the charge",
      capture_pending: "Charge pending at PayPal",
      payout_failed: "Technician payout failed",
      reauth_failed: "Hold renewal failed",
      hold_lost: "PayPal released the hold",
      authorization_pending: "PayPal is reviewing the approval",
    };
    if (text[added]) {
      return {
        text: text[added],
        tone: added === "capture_pending" || added === "authorization_pending" ? "warning" : "danger",
        kind: "problem",
      };
    }
  }
  if (removed) {
    if (e.reason === "reapproved") return { text: "Customer approved the hold again", tone: "brand", kind: "hold" };
    if (e.reason === "fallback_invoice_paid") return { text: "Paid by invoice", tone: "success", kind: "invoice" };
    const text: Record<string, string> = {
      capture_failed: "Charge problem resolved",
      capture_pending: "PayPal confirmed the charge",
      payout_failed: "Payout sent again",
      authorization_pending: "PayPal finished the review",
    };
    if (text[removed]) return { text: text[removed], tone: "neutral", kind: "charge" };
    return null;
  }
  switch (e.flag) {
    case "reauthorized":
      return { text: "Hold renewed at PayPal", tone: "brand", kind: "hold" };
    case "orphan_void":
      return { text: "A stray hold was released", tone: "neutral", kind: "release" };
    case "fallback_paid_after_release":
      return { text: "Invoice paid after the hold was released · refund needed", tone: "danger", kind: "problem" };
    case "refunded":
      return { text: "Charge refunded", tone: "neutral", kind: "charge" };
    case "reversed":
      return { text: "Charge reversed", tone: "danger", kind: "problem" };
    default:
      return null;
  }
}

/** Who did it, for the timeline: "AI receptionist", "Customer", "You", "PayPal", "Holdline". */
export function actorLabel(actor: string): string {
  return (
    { agent: "AI receptionist", customer: "Customer", owner: "You", webhook: "PayPal", system: "Holdline" }[actor] ??
    "Holdline"
  );
}

export const CAPTURE_KIND: Record<string, string> = {
  full: "Charged",
  no_show_fee: "No-show fee charged",
  late_cancel_fee: "Late-cancellation fee charged",
};

/** A capture's PayPal state in plain words. */
export function captureStatusLabel(status: string): string {
  return (
    {
      COMPLETED: "Completed",
      PENDING: "Pending at PayPal",
      DECLINED: "Declined",
      FAILED: "Failed",
      REFUNDED: "Refunded",
      PARTIALLY_REFUNDED: "Partly refunded",
      REVERSED: "Reversed",
    }[status] ?? "Updating"
  );
}

export function authorizationStatusLabel(status: string): string {
  return (
    {
      CREATED: "On hold",
      PENDING: "Under review",
      CAPTURED: "Charged",
      PARTIALLY_CAPTURED: "Partly charged",
      VOIDED: "Released",
      EXPIRED: "Expired",
      DENIED: "Declined",
    }[status] ?? "Updating"
  );
}

export function orderStatusLabel(status: string): string {
  return (
    {
      CREATED: "Created",
      PAYER_ACTION_REQUIRED: "Waiting for the customer",
      APPROVED: "Approved by the customer",
      COMPLETED: "Completed",
      VOIDED: "Closed",
    }[status] ?? "Updating"
  );
}

export function invoiceStatusLabel(status: string): string {
  return { draft: "Preparing", sent: "Sent", paid: "Paid", cancelled: "Cancelled" }[status] ?? "Updating";
}

export function payoutStatusLabel(status: string): string {
  return (
    {
      pending: "Queued",
      processing: "Sent",
      unclaimed: "Not claimed yet",
      cancelling: "Cancelling",
      succeeded: "Paid out",
      failed: "Failed",
      needs_review: "Held for review",
    }[status] ?? "Updating"
  );
}

export function payoutTone(status: string): LineTone {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "needs_review" || status === "unclaimed") return "danger";
  if (status === "processing" || status === "cancelling") return "brand";
  return "neutral";
}

/** One payout as an activity line: "Technician payout sent · Maya · $89.40". */
export function payoutLine(p: { status: string; amountCents: number; attemptNo: number }, tech: string): Line {
  const amount = usd(p.amountCents);
  switch (p.status) {
    case "pending":
      return { text: `Technician payout queued · ${tech} · ${amount}`, tone: "neutral", kind: "payout" };
    case "failed":
    case "needs_review":
      return { text: `Technician payout failed · ${tech} · ${amount}`, tone: "danger", kind: "problem" };
    case "unclaimed":
    case "cancelling":
      return { text: `Technician payout not claimed · ${tech} · ${amount}`, tone: "warning", kind: "payout" };
    default:
      return {
        text: `Technician payout ${p.attemptNo > 1 ? "sent again" : "sent"} · ${tech} · ${amount}`,
        tone: p.status === "succeeded" ? "success" : "brand",
        kind: "payout",
      };
  }
}

/** One invoice as an activity line, or null for a draft. */
export function invoiceLine(i: { status: string; kind: string; totalCents: number; paidCents: number }): Line | null {
  const what = i.kind === "fallback" ? "Invoice for the visit" : "Extra-work invoice";
  switch (i.status) {
    case "sent":
      return { text: `${what} sent · ${usd(i.totalCents)}`, tone: "brand", kind: "invoice" };
    case "paid":
      return { text: `${what} paid · ${usd(i.paidCents || i.totalCents)}`, tone: "success", kind: "invoice" };
    case "cancelled":
      return { text: `${what} cancelled`, tone: "neutral", kind: "invoice" };
    default:
      return null;
  }
}

/** The AI summary's outcome code in owner words. */
export function summaryOutcomeLabel(outcome: unknown): string | null {
  if (typeof outcome !== "string") return null;
  return (
    {
      booked_and_authorized: "Booked, hold approved",
      booked_pending_payment: "Booked, waiting for the hold",
      no_booking: "No booking",
      safety_issue: "Safety issue",
      other: "Other",
    }[outcome] ?? null
  );
}

export const OUTBOX_STATUS: Record<string, { label: string; tone: LineTone }> = {
  outbox_only: { label: "Shown here only", tone: "neutral" },
  sent: { label: "Sent", tone: "success" },
  pending: { label: "Sending…", tone: "brand" },
  failed: { label: "Not delivered", tone: "danger" },
};
