import type { Metadata } from "next";

import { PayLink } from "@/components/try/pay-link";
import { readVar } from "@/server/config/env";
import { slotLabel } from "@/server/domain/time";
import { formatUsd } from "@/server/money";
import { buyerFor } from "@/server/workspaces/demo";
import { getDb } from "@/db/client";
import { payLinkView, payPalMocked } from "@/server/try/pay";
import { panelFor, type PanelState } from "@/server/try/state";

export const metadata: Metadata = { title: "Approve your hold", robots: { index: false, follow: false } };

/** States a spent or finished link may still show. */
const FINAL = new Set<PanelState>([
  "authorized",
  "done",
  "late_cancel",
  "no_show",
  "fee_pending",
  "missed",
  "cancelled",
  "expired",
]);

/** /pay/{token} (SPEC §20): the email link or a single-use device link; the token is the only key. */
export default async function PayPage({ params }: PageProps<"/pay/[token]">) {
  const { token } = await params;
  const found = await payLinkView(token);
  // A used or finished link still shows how the booking ended, read-only; anything else is gone.
  const panel = found ? await panelFor(getDb(), found.booking) : null;
  if (!found || !panel || (!found.live && !FINAL.has(panel))) {
    return (
      <div className="mx-auto max-w-lg px-6 py-16">
        <h1 className="text-2xl font-semibold">This link has expired</h1>
        <p className="mt-2 text-muted-foreground">
          Pay links work until the booking&apos;s payment window closes, and phone links work once.
        </p>
      </div>
    );
  }
  const { booking: b, ws, tech } = found;
  return (
    <div className="mx-auto max-w-lg space-y-4 px-6 py-10">
      <h1 className="text-2xl font-semibold">{ws.name}</h1>
      <PayLink
        token={token}
        booking={{
          id: b.id,
          ref: b.ref,
          panel,
          serviceName: b.serviceName,
          appointment: slotLabel(b.slotStart, b.slotEnd, ws.timezone),
          technicianFirstName: tech.split(" ")[0],
          holdAmount: formatUsd(b.priceCents),
          noShowFee: formatUsd(b.noShowFeeCents),
        }}
        readOnly={!found.live}
        buyer={found.live && ws.kind === "demo" ? buyerFor(ws.sandboxBuyerIndex) : null}
        clientId={readVar(process.env, "PAYPAL_CLIENT_ID") ?? null}
        mocked={payPalMocked()}
      />
    </div>
  );
}
