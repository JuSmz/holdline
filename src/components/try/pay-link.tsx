"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { type PanelBooking, PayPanel } from "./pay-panel";

/** States that can still change on their own (a webhook, the reconciler): the page re-reads them. */
const LIVE = new Set<PanelBooking["panel"]>(["waiting", "processing", "declined_retry", "reapprove"]);

/** The pay panel on /pay/{token}: the same panel, with the token routes instead of the cookie routes. */
export function PayLink(props: {
  token: string;
  booking: PanelBooking;
  buyer: { email: string; password: string } | null;
  clientId: string | null;
  mocked: boolean;
  /** A used or finished link: only the final state, no polling, no payment. */
  readOnly?: boolean;
  /** false when the page already puts the panel in a card. */
  framed?: boolean;
}) {
  const router = useRouter();
  const live = !props.readOnly && LIVE.has(props.booking.panel);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [live, router]);
  const base = `/api/pay/${encodeURIComponent(props.token)}`;
  return (
    <PayPanel
      key={props.booking.id}
      booking={props.booking}
      buyer={props.buyer}
      clientId={props.clientId}
      mocked={props.mocked}
      endpoints={{ order: `${base}/order`, authorize: `${base}/authorize`, mockApprove: `${base}/mock-approve` }}
      onAuthorized={() => router.refresh()}
      framed={props.framed}
    />
  );
}
