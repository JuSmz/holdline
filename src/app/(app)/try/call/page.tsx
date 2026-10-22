import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CallDemo } from "@/components/try/call-demo";
import { readVar } from "@/server/config/env";
import { payPalMocked } from "@/server/try/pay";
import { currentDemoWorkspace } from "@/server/workspaces/session";

export const metadata: Metadata = { title: "Call demo", robots: { index: false, follow: false } };

/** /try/call (SPEC §16): the browser call and the pay panel on one screen. */
export default async function TryCallPage() {
  const ws = await currentDemoWorkspace();
  if (!ws) redirect("/try");
  return (
    <CallDemo
      businessName={ws.name}
      defaults={{ firstName: "Sam", email: "sam@example.com" }}
      clientId={readVar(process.env, "PAYPAL_CLIENT_ID") ?? null}
      mocked={payPalMocked()}
    />
  );
}
