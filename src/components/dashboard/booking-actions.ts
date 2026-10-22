"use client";

import type { ConfirmSpec } from "@/components/ui/confirm-dialog";
import type { ActionKey } from "@/server/dashboard/actions";

import type { Row } from "./shared";

/**
 * What a click sends: the action and, for Cancel, the rule the owner saw (none for a withdraw: the server
 * then refuses if a hold appeared meanwhile), for Retry payout the payout the dialog named; never an amount.
 */
export type ActionBody =
  | { action: Exclude<ActionKey, "cancel" | "extra_work" | "retry_payout"> }
  | { action: "cancel"; expectLate?: boolean }
  | { action: "retry_payout"; payoutId: string }
  | { action: "extra_work"; items: { addonKey: string; quantity: number }[] };

export type PendingAction = { key: ActionKey; spec: ConfirmSpec; body: ActionBody };

/** Button labels; the first action of a booking is its primary one when it moves the job forward. */
export function actionLabel(row: Row, key: ActionKey): string {
  switch (key) {
    case "job_done":
      return "Job done";
    case "no_show":
      return "No-show";
    case "cancel":
      return row.status === "pending_payment"
        ? "Withdraw booking"
        : row.status === "cancelled"
          ? "Release hold"
          : "Cancel booking";
    case "waive_fee":
      return "Waive fee";
    case "extra_work":
      return "Add extra work";
    case "retry_capture":
      return "Retry capture";
    case "bill_via_invoice":
      return "Bill by invoice";
    case "retry_payout":
      return "Retry payout";
  }
}

export const PRIMARY_ACTIONS: ReadonlySet<ActionKey> = new Set(["job_done", "retry_capture", "retry_payout"]);

// The rule and "has it started" come from the server clock (row.lateNow / row.started, refreshed on
// every poll), never the device's: a skewed clock would otherwise get refused every time. The server
// re-checks the rule on confirm, for a window crossing within the last few seconds.
const notStarted = (row: Row) => (row.started ? "" : " The visit hasn't started yet — only confirm if that's right.");

/**
 * The confirmation for an action (SPEC §18: the exact amount and the rule that applies). Amounts are the
 * booking's own snapshot as the server sent it; the server charges from the same snapshot.
 */
export function pendingFor(row: Row, key: Exclude<ActionKey, "extra_work">): PendingAction {
  const h = row.cancelWindowHours;
  const zeroFee = row.noShowFee === "$0.00";
  switch (key) {
    case "job_done":
      return {
        key,
        body: { action: key },
        spec: {
          title: "Mark the job done?",
          body: `Holdline charges the full hold for ${row.serviceName}, and ${row.technician}'s payout goes out right after.${notStarted(row)}`,
          money: `${row.hold} · the booked price, charged to the customer's PayPal hold`,
          confirmLabel: `Charge ${row.hold}`,
        },
      };
    case "no_show":
      return {
        key,
        body: { action: key },
        spec: zeroFee
          ? {
              title: "Mark as no-show?",
              body: `This service has no no-show fee, so the whole ${row.hold} hold is released.${notStarted(row)}`,
              money: "$0.00 · no fee for this service",
              confirmLabel: "Release hold",
            }
          : {
              title: "Mark as no-show?",
              body: `The customer wasn't there. Holdline charges the no-show fee and releases the rest of the ${row.hold} hold.${notStarted(row)}`,
              money: `${row.noShowFee} no-show fee · the rest of the hold is released`,
              confirmLabel: `Charge ${row.noShowFee}`,
            },
      };
    case "cancel": {
      if (row.status === "pending_payment") {
        return {
          key,
          body: { action: key },
          spec: {
            title: "Withdraw this booking?",
            body: "The customer hasn't approved the PayPal hold yet. The time slot is freed and the pay link stops working.",
            money: "$0.00 · no hold was placed, nothing is charged",
            confirmLabel: "Withdraw",
            cancelLabel: "Keep booking",
            tone: "destructive",
          },
        };
      }
      if (row.status === "cancelled") {
        return {
          key,
          body: { action: key },
          spec: {
            title: "Release the hold?",
            body: "The booking is cancelled, but PayPal hasn't released the hold yet. Holdline asks again.",
            money: `$0.00 · the ${row.hold} hold is released`,
            confirmLabel: "Release hold",
          },
        };
      }
      const late = row.lateNow;
      return {
        key,
        body: { action: key, expectLate: late },
        spec: late
          ? {
              title: "Cancel this booking?",
              body: `It's less than ${h} hours before the visit, so the late-cancellation fee applies. The rest of the hold is released.`,
              money: zeroFee
                ? `$0.00 · late, but this service has no fee`
                : `${row.noShowFee} late-cancellation fee · less than ${h} h before the visit`,
              confirmLabel: zeroFee ? "Cancel booking" : `Cancel and charge ${row.noShowFee}`,
              cancelLabel: "Keep booking",
              tone: "destructive",
            }
          : {
              title: "Cancel this booking?",
              body: `It's more than ${h} hours before the visit, so cancelling is free.`,
              money: `$0.00 · free cancellation, the ${row.hold} hold is released`,
              confirmLabel: "Cancel booking",
              cancelLabel: "Keep booking",
              tone: "destructive",
            },
      };
    }
    case "waive_fee":
      return {
        key,
        body: { action: key },
        spec: {
          title: "Waive the fee?",
          body: "The customer isn't charged anything, and the whole hold is released.",
          money: `$0.00 · the ${row.noShowFee} fee is waived, the ${row.hold} hold released`,
          confirmLabel: "Waive fee",
        },
      };
    case "retry_capture":
      return {
        key,
        body: { action: key },
        spec: {
          title: "Retry the capture?",
          body: "PayPal declined it last time. Holdline asks PayPal again, on the same hold.",
          money: `${row.due} · charged to the hold if PayPal accepts`,
          confirmLabel: `Retry ${row.due}`,
        },
      };
    case "bill_via_invoice":
      return {
        key,
        body: { action: key },
        spec: {
          title: "Bill by invoice instead?",
          body: "Holdline releases the hold first, then sends the customer a PayPal invoice. After this, Retry capture is no longer possible.",
          money: `${row.due} invoice · one line, the booked amount`,
          confirmLabel: "Send invoice",
        },
      };
    case "retry_payout": {
      const p = row.failedPayout;
      return {
        key,
        // Without a failed payout the action isn't offered; an empty ID is refused by the server.
        body: { action: key, payoutId: p?.id ?? "" },
        spec: {
          title: "Send the payout again?",
          body: `The last payout${p ? ` to ${p.technician}` : ""} didn't go through. Holdline sends a new one.`,
          money: p ? `${p.amount} to ${p.technician} · the technician's share` : "The technician's share",
          confirmLabel: "Send payout",
        },
      };
    }
  }
}

export type AddonOption = { key: string; name: string; unit: string; price: string; unitPriceCents: number };

// The same format as the server's formatUsd ("$1234.50"), so the dialog matches the invoice.
const usd = (cents: number) => `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/** One invoice holds at most $2,000 (MAX_INVOICE_TOTAL_CENTS in src/server/paypal/invoicing.ts; a test pins it). */
export const MAX_INVOICE_CENTS = 200_000;
export const MAX_INVOICE_LABEL = "$2,000";

const extraWorkCents = (addons: AddonOption[], quantities: Record<string, number>) =>
  addons.reduce((s, a) => s + a.unitPriceCents * (quantities[a.key] ?? 0), 0);

/** The picked lines cost more than one invoice can hold: the picker says so instead of offering a review. */
export function overInvoiceCap(addons: AddonOption[], quantities: Record<string, number>): boolean {
  return extraWorkCents(addons, quantities) > MAX_INVOICE_CENTS;
}

/** Extra work: the lines the owner picked, priced from the price list (the server prices them again). */
export function extraWorkPending(addons: AddonOption[], quantities: Record<string, number>): PendingAction | null {
  const lines = addons.filter((a) => (quantities[a.key] ?? 0) > 0);
  if (lines.length === 0 || overInvoiceCap(addons, quantities)) return null;
  const total = extraWorkCents(addons, quantities);
  return {
    key: "extra_work",
    body: { action: "extra_work", items: lines.map((a) => ({ addonKey: a.key, quantity: quantities[a.key] })) },
    spec: {
      title: "Send an extra-work invoice?",
      body: `The customer gets a PayPal invoice for: ${lines.map((a) => `${quantities[a.key]} × ${a.name}`).join(", ")}.`,
      money: `${usd(total)} invoice · prices from your price list`,
      confirmLabel: `Send ${usd(total)} invoice`,
    },
  };
}

export function extraWorkTotal(addons: AddonOption[], quantities: Record<string, number>): string {
  return usd(extraWorkCents(addons, quantities));
}

export type ActionReply =
  | { ok: true; message: string; bookingStatus: string; outcome: string; flag: string | null }
  | { ok: false; message: string; inProgress?: boolean };

/** Outcomes of a money action that mean PayPal hasn't finished yet (MoneyOutcome, invoice states). */
const STILL_WORKING = new Set(["capture_pending", "processing", "invoice_draft"]);

/**
 * How a successful reply reads in the toast: a declined charge or a refused payout is a problem (red),
 * a step PayPal is still finishing is info, everything else a success. `ok` only means "no refusal".
 */
export function replyTone(action: ActionKey, reply: Extract<ActionReply, { ok: true }>): "success" | "info" | "danger" {
  if (reply.outcome === "capture_failed") return "danger";
  if (action === "retry_payout") {
    if (["failed", "unclaimed", "needs_review"].includes(reply.outcome)) return "danger";
    return reply.outcome === "succeeded" ? "success" : "info";
  }
  if (reply.flag === "capture_pending" || STILL_WORKING.has(reply.outcome)) return "info";
  return "success";
}

/** POSTs the action; turns every answer into one sentence for the page. */
export async function sendAction(bookingId: string, body: ActionBody): Promise<ActionReply> {
  try {
    const res = await fetch(`/api/dashboard/bookings/${bookingId}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      message?: string;
      bookingStatus?: string;
      outcome?: string;
      flag?: string | null;
    } | null;
    if (res.ok && json?.ok) {
      return {
        ok: true,
        message: json.message ?? "Done.",
        bookingStatus: json.bookingStatus ?? "",
        outcome: json.outcome ?? "",
        flag: json.flag ?? null,
      };
    }
    if (res.status === 202) return { ok: false, inProgress: true, message: "PayPal is still working on it…" };
    if (res.status === 401)
      return { ok: false, message: "This demo copy is gone. Start a new one from the Customer view." };
    return { ok: false, message: json?.message ?? "That didn't work. Try again in a moment." };
  } catch {
    return { ok: false, message: "No connection. Try again in a moment." };
  }
}
