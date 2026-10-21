import { MAX_INVOICE_TOTAL_CENTS } from "@/server/paypal/invoicing";

/** The price snapshot a booking stores at creation (SPEC §9.1). Every later amount derives from it. */
export function priceSnapshot(service: { name: string; priceCents: number; noShowFeeCents: number }) {
  if (!Number.isInteger(service.priceCents) || service.priceCents <= 0) throw new Error("invalid service price");
  if (!Number.isInteger(service.noShowFeeCents) || service.noShowFeeCents < 0) throw new Error("invalid no-show fee");
  if (service.noShowFeeCents > service.priceCents) throw new Error("the no-show fee exceeds the price");
  return {
    serviceName: service.name,
    priceCents: service.priceCents,
    noShowFeeCents: service.noShowFeeCents,
    currency: "USD" as const,
  };
}

/** Technician share: floor(recognised × bps / 10000) (SPEC §9.1). Never rounds up. */
export function payoutCents(recognisedCents: number, shareBps: number): number {
  if (!Number.isInteger(recognisedCents) || recognisedCents < 0) throw new Error("invalid recognised amount");
  if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > 10_000) throw new Error("invalid payout share");
  return Math.floor((recognisedCents * shareBps) / 10_000);
}

export type AddonPick = { addonId: string; quantity: number };
export type AddonRow = { id: string; key: string; name: string; unitPriceCents: number; active: boolean };

export class InvoiceInputError extends Error {
  readonly status = 400;
}

/**
 * Extra-work lines from the workspace's add-ons only (SPEC §9.1): integer quantity 1–20, each add-on
 * once, the total capped at $2,000. Client input carries IDs and quantities, never amounts.
 */
export function extraWorkLines(addons: AddonRow[], picks: AddonPick[]) {
  if (picks.length === 0 || picks.length > 10) throw new InvoiceInputError("pick 1–10 add-ons");
  const byId = new Map(addons.map((a) => [a.id, a]));
  const seen = new Set<string>();
  const lines = picks.map((pick) => {
    const addon = byId.get(pick.addonId);
    if (!addon || !addon.active) throw new InvoiceInputError("unknown add-on");
    if (seen.has(addon.id)) throw new InvoiceInputError("each add-on only once");
    seen.add(addon.id);
    if (!Number.isInteger(pick.quantity) || pick.quantity < 1 || pick.quantity > 20) {
      throw new InvoiceInputError("quantity must be 1–20");
    }
    return { key: addon.key, name: addon.name, quantity: pick.quantity, unitAmountCents: addon.unitPriceCents };
  });
  const totalCents = lines.reduce((sum, l) => sum + l.quantity * l.unitAmountCents, 0);
  if (totalCents <= 0 || totalCents > MAX_INVOICE_TOTAL_CENTS) throw new InvoiceInputError("total out of range");
  return { lines, totalCents };
}
