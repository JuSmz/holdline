import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ChatDemo } from "@/components/try/chat-demo";
import { readVar } from "@/server/config/env";
import { payPalMocked } from "@/server/try/pay";
import { currentDemoWorkspace } from "@/server/workspaces/session";

export const metadata: Metadata = { title: "Chat demo", robots: { index: false, follow: false } };

/** /try/chat (SPEC §15): the text channel of the agent, with the pay panel beside it. */
export default async function TryChatPage() {
  const ws = await currentDemoWorkspace();
  if (!ws) redirect("/try");
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-10">
      <header>
        <p className="text-sm font-medium text-brand">Step 1 · Be the customer</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Chat with {ws.name}</h1>
      </header>
      <ChatDemo
        defaults={{ firstName: "Sam", email: "sam@example.com" }}
        clientId={readVar(process.env, "PAYPAL_CLIENT_ID") ?? null}
        mocked={payPalMocked()}
      />
    </div>
  );
}
