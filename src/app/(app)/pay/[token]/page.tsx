import { Clock } from "lucide-react";
import type { Metadata } from "next";

import { PayLink } from "@/components/try/pay-link";
import { Card } from "@/components/ui/card";
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
      <div className="mx-auto max-w-md px-4 py-10 sm:py-20">
        <Card className="flex flex-col items-center px-6 py-10 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-neutral-soft text-muted-foreground">
            <Clock className="size-6" aria-hidden />
          </span>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">This link has expired</h1>
          <p className="mt-2 max-w-xs text-sm text-pretty text-muted-foreground">
            Pay links work until the booking&apos;s payment window closes, and phone links work once.
          </p>
        </Card>
      </div>
    );
  }
  const { booking: b, ws, tech } = found;
  return (
    <div className="mx-auto max-w-md px-4 py-6 sm:py-14">
      <Card className="overflow-hidden rounded-3xl">
        <header className="flex items-center gap-3 border-b border-border px-5 py-4 sm:px-6">
          <span
            aria-hidden
            className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground text-base font-semibold text-background"
          >
            {ws.name.charAt(0)}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[15px] leading-tight font-semibold">{ws.name}</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">PayPal sandbox · test money</p>
          </div>
        </header>
        <div className="px-5 py-6 sm:px-6">
          <PayLink
            token={token}
            booking={{
              id: b.id,
              ref: b.ref,
              panel,
              status: b.status,
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
            framed={false}
          />
        </div>
      </Card>
    </div>
  );
}
