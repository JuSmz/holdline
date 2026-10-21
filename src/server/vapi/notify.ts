import { dbErrorCode } from "@/server/db-error";

import { rememberControlUrl, type CallBinding } from "./calls";
import { getVapiClient } from "./client";
import { isAllowedControlUrl, sendControl, type ControlResult } from "./control";

export type PaymentNotice = "authorized" | "declined_retry" | "expired";

/**
 * Stage-4 lab sentences. The real notifyCall (stage 6/8) renders them from the booking in the
 * database and dedupes on call_notifications (SPEC §16); the wording stays the same.
 */
export const LAB_NOTICE_TEXT: Record<PaymentNotice, string> = {
  authorized:
    "Got it — PayPal confirmed the $149 hold. You're all set for Thursday 10 to 12, Austin time. Maya will be there.",
  declined_retry: "PayPal didn't accept that payment method — you can try another one in the same window.",
  expired: "The payment window has closed; I can set up a new link if you like.",
};

export type NoticeOutcome = {
  controlUrlSource: "binding" | "api" | "none";
  say: ControlResult | null;
  addMessage: ControlResult | null;
};

/** The controlUrl from the binding, otherwise from GET /call/{id} (then remembered). */
async function controlUrlFor(
  binding: CallBinding,
): Promise<{ url: string | null; source: NoticeOutcome["controlUrlSource"] }> {
  if (isAllowedControlUrl(binding.controlUrl)) return { url: binding.controlUrl, source: "binding" };
  if (!binding.vapiCallId) return { url: null, source: "none" };
  const call = await getVapiClient().get<{ monitor?: { controlUrl?: string } }>(
    `/call/${encodeURIComponent(binding.vapiCallId)}`,
  );
  const url = call?.monitor?.controlUrl;
  if (!isAllowedControlUrl(url)) return { url: null, source: "none" };
  try {
    await rememberControlUrl(binding.vapiCallId, url);
  } catch (error) {
    // Only a cache write: the notice still goes out. Code only, the message would carry the URL.
    console.error(`[holdline] could not store controlUrl for ${binding.vapiCallId}: ${dbErrorCode(error)}`);
  }
  return { url, source: "api" };
}

/** `say` the fixed sentence, then `add-message` so the model's context matches what was said (SPEC §16). */
export async function sendPaymentNotice(
  binding: CallBinding,
  notice: PaymentNotice,
  bookingRef: string,
): Promise<NoticeOutcome> {
  const { url, source } = await controlUrlFor(binding);
  if (!url) return { controlUrlSource: source, say: null, addMessage: null };
  const say = await sendControl(url, {
    type: "say",
    content: LAB_NOTICE_TEXT[notice],
    interruptionsEnabled: false,
    interruptAssistantEnabled: false,
  });
  const addMessage = say.ok
    ? await sendControl(url, {
        type: "add-message",
        message: { role: "system", content: `[payment-update] ${bookingRef} ${notice}; the caller has been told.` },
        triggerResponseEnabled: false,
      })
    : null;
  return { controlUrlSource: source, say, addMessage };
}
