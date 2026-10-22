import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { type ChatResume, ChatDemo } from "@/components/try/chat-demo";
import { getDb } from "@/db/client";
import { STARTER_CHIPS } from "@/server/chat/runtime";
import { readVar } from "@/server/config/env";
import { payPalMocked } from "@/server/try/pay";
import { conversationState } from "@/server/try/state";
import { workspaceCall } from "@/server/workspaces/guard";
import { currentDemoWorkspace } from "@/server/workspaces/session";

export const metadata: Metadata = { title: "Chat demo", robots: { index: false, follow: false } };

const DEFAULTS = { firstName: "Sam", email: "sam@example.com" };

/**
 * /try/chat (SPEC §15): the text channel of the agent, with the pay panel beside it. `?c=<id>` picks a
 * conversation back up (the page sets it once the chat starts): only a chat of the cookie's own demo
 * copy, never a call, the owner lab or sample history; anything else starts a new chat.
 */
export default async function TryChatPage({ searchParams }: PageProps<"/try/chat">) {
  const ws = await currentDemoWorkspace();
  if (!ws) redirect("/try");
  const { c } = await searchParams;
  let resume: ChatResume | null = null;
  if (c !== undefined) {
    const call = typeof c === "string" ? await workspaceCall(ws, c) : null;
    if (!call || call.channel !== "chat" || call.lab || call.sample) redirect("/try/chat");
    const state = await conversationState(getDb(), ws, call);
    resume = {
      chatId: call.id,
      identity: {
        firstName: call.caller?.firstName ?? DEFAULTS.firstName,
        email: call.caller?.email ?? DEFAULTS.email,
      },
      state: { booking: state.booking, buyer: state.buyer, lines: state.lines, notify: state.notify },
    };
  }
  return (
    <ChatDemo
      key={resume?.chatId ?? "new"}
      businessName={ws.name}
      starters={[...STARTER_CHIPS]}
      defaults={DEFAULTS}
      clientId={readVar(process.env, "PAYPAL_CLIENT_ID") ?? null}
      mocked={payPalMocked()}
      resume={resume}
    />
  );
}
