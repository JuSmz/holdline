import { after } from "next/server";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db/client";
import { bookings, callNotifications, calls, technicians, workspaces } from "@/db/schema";
import type { Db, Executor } from "@/db/types";
import { appendChat } from "@/server/chat/transcript";
import { dbErrorCode } from "@/server/db-error";
import { spokenSlot } from "@/server/domain/time";
import { spokenUsd } from "@/server/money";
import type { CallNotice } from "@/server/payments/context";
import { paymentUpdateNote, sendCallNotice } from "@/server/vapi/notify";

import { scheduleSummary } from "./summary";

/** The fixed sentences of SPEC §16, rendered from the booking in the database. */
export async function noticeText(db: Executor, bookingId: string, notice: CallNotice): Promise<string> {
  if (notice === "declined_retry") {
    return "PayPal didn't accept that payment method — you can try another one in the same window.";
  }
  if (notice === "expired") return "The payment window has closed; I can set up a new link if you like.";
  const [row] = await db
    .select({ booking: bookings, timezone: workspaces.timezone, tech: technicians.name })
    .from(bookings)
    .innerJoin(workspaces, eq(workspaces.id, bookings.workspaceId))
    .innerJoin(technicians, eq(technicians.id, bookings.technicianId))
    .where(eq(bookings.id, bookingId));
  const b = row.booking;
  return `Got it — PayPal confirmed the ${spokenUsd(b.priceCents)} hold. You're all set for ${spokenSlot(
    b.slotStart,
    b.slotEnd,
    row.timezone,
  )}. ${row.tech.split(" ")[0]} will be there.`;
}

export type NotifyResult =
  { sent: false; reason: "no_call" | "already_sent" } | { sent: true; via: "server" | "chat"; ok: boolean };

/** spoken, not_spoken (definite: no controlUrl, an HTTP error, or nothing sent) or unknown (timeout). */
export type VoiceOutcome = "spoken" | "not_spoken" | "unknown";

/**
 * How long a claim may stay unsettled before the page may speak instead (the server attempt died).
 * Above the server's longest path before `say` (the GET /call lookup, 10 s); the claim is refreshed
 * right before speaking, which leaves `say` and `add-message` (3 s each) well inside it.
 */
export const STUCK_CLAIM_MS = 20_000;

/**
 * Whether the page may speak the confirmation itself (SPEC §16.7): only after a definite not_spoken,
 * or a server claim that never settled. A timed-out say may have been heard, so it is never repeated.
 */
export function browserFallbackAllowed(
  row: { via: string | null; outcome: string | null; sentAt: Date },
  now: Date,
): boolean {
  if (row.via !== "server") return false;
  return (
    row.outcome === "not_spoken" || (row.outcome === null && now.getTime() - row.sentAt.getTime() > STUCK_CLAIM_MS)
  );
}

/**
 * notifyCall (SPEC §16): tells the conversation a payment result, at most once per (booking, status,
 * channel). Chat: the claim, the confirmation line and the [payment-update] note commit together, so a
 * failure leaves nothing claimed and a retry can post it. Voice: `say` + `add-message` through the
 * controlUrl; the outcome records only whether the sentence was spoken.
 */
export async function notifyCall(bookingId: string, notice: CallNotice, db: Db = getDb()): Promise<NotifyResult> {
  const [row] = await db
    .select({ ref: bookings.ref, call: calls })
    .from(bookings)
    .innerJoin(calls, eq(calls.id, bookings.callId))
    .where(eq(bookings.id, bookingId));
  if (!row) return { sent: false, reason: "no_call" };
  const { call } = row;
  const note = paymentUpdateNote(row.ref, notice);

  if (call.channel === "chat") {
    const appended = await db.transaction(async (tx) => {
      // The calls row first, then the booking (via the claim's foreign key): the same lock order as
      // create_booking_with_payment_link, so the two can't deadlock.
      await tx.select({ id: calls.id }).from(calls).where(eq(calls.id, call.id)).for("update");
      const [claimed] = await tx
        .insert(callNotifications)
        .values({ bookingId, status: notice, channel: "chat", via: "chat", ok: true, outcome: "appended" })
        .onConflictDoNothing()
        .returning({ id: callNotifications.id });
      if (!claimed) return false;
      const text = await noticeText(tx, bookingId, notice);
      await appendChat(tx, call.id, {
        lines: [{ role: "assistant", text, at: new Date().toISOString(), notice }],
        // A user-role note, then the sentence as the model's own turn: the history keeps alternating.
        contents: [
          { role: "user", parts: [{ text: note }] },
          { role: "model", parts: [{ text }] },
        ],
      });
      return true;
    });
    if (!appended) return { sent: false, reason: "already_sent" };
    if (notice === "authorized") scheduleSummary(call.id);
    return { sent: true, via: "chat", ok: true };
  }

  const [claimed] = await db
    .insert(callNotifications)
    .values({ bookingId, status: notice, channel: call.channel, via: "server" })
    .onConflictDoNothing()
    .returning({ id: callNotifications.id });
  if (!claimed) return { sent: false, reason: "already_sent" };
  const ours = and(eq(callNotifications.id, claimed.id), eq(callNotifications.via, "server"));
  // Right before speaking: still ours (the page hasn't taken over)? Refresh the claim's clock too.
  const stillOurs = async () =>
    (
      await db
        .update(callNotifications)
        .set({ sentAt: new Date() })
        .where(and(ours, isNull(callNotifications.outcome)))
        .returning({ id: callNotifications.id })
    ).length > 0;
  let outcome: VoiceOutcome = "not_spoken";
  let skipped = false;
  try {
    const text = await noticeText(db, bookingId, notice);
    const sent = await sendCallNotice(call, { say: text, note }, stillOurs);
    skipped = sent.skipped === true;
    outcome = !sent.say ? "not_spoken" : sent.say.ok ? "spoken" : sent.say.status !== null ? "not_spoken" : "unknown";
    if (sent.say?.ok && !sent.addMessage?.ok) {
      // Spoken, but the model's context misses the note: it can still ask check_payment_status.
      console.warn(`[holdline] add-message after the ${notice} notice failed for booking ${bookingId}`);
    }
  } finally {
    // Only while the row is still the server's: a browser takeover keeps its own record.
    if (!skipped)
      await db
        .update(callNotifications)
        .set({ ok: outcome === "spoken", outcome })
        .where(ours);
  }
  if (skipped) return { sent: false, reason: "already_sent" };
  return { sent: true, via: "server", ok: outcome === "spoken" };
}

/** Runs notifyCall after the response when inside a request (SPEC §16), otherwise right away. */
export function scheduleNotify(bookingId: string, notice: CallNotice): void {
  const run = () =>
    notifyCall(bookingId, notice).catch((error: unknown) => {
      console.error(`[holdline] notifyCall ${notice} for ${bookingId} failed: ${dbErrorCode(error)}`);
    });
  try {
    after(run);
  } catch {
    void run();
  }
}
