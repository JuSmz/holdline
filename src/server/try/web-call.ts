import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { calls } from "@/db/schema";
import type { Db, Executor } from "@/db/types";
import { readVar } from "@/server/config/env";
import { consume, peek } from "@/server/security/rate-limit";
import { sign, verify } from "@/server/security/tokens";
import { isAllowedControlUrl } from "@/server/vapi/control";

/**
 * Web-call caps (SPEC §22). The real protection is the global daily voice-minute cap: each call
 * reserves its maximum length up front, and the end-of-call report settles the real minutes.
 */
export const WEB_CALL_LIMITS = { perWorkspaceDay: 3, perIpDay: 6, concurrent: 4 } as const;

/** The pre-call form, carried to the proxy in a short signed cookie (the Vapi SDK sends its own body). */
export const CALLER_COOKIE = "__Host-hl_caller";
export const CALLER_COOKIE_TTL_SECONDS = 15 * 60;

export type WebCaller = { ws: string; firstName: string; email: string };

export function callerCookieValue(caller: WebCaller, now = new Date()): string {
  return sign("web-caller", caller, CALLER_COOKIE_TTL_SECONDS, { now });
}

export function callerFromCookie(value: string | undefined, workspaceId: string): WebCaller | null {
  const claims = verify<Partial<WebCaller>>("web-caller", value);
  if (!claims || claims.ws !== workspaceId) return null;
  if (typeof claims.firstName !== "string" || typeof claims.email !== "string") return null;
  return { ws: claims.ws, firstName: claims.firstName, email: claims.email };
}

export class VoiceBusyError extends Error {
  constructor(readonly reason: "minutes" | "concurrent" | "workspace" | "ip" | "off") {
    super(
      reason === "workspace" || reason === "ip"
        ? "You've used today's browser calls for this demo copy — the chat uses the same agent and payment flow."
        : "Voice line busy — the chat uses the same agent and payment flow.",
    );
    this.name = "VoiceBusyError";
  }
}

const MINUTES_SCOPE = "voice_minutes";

export function dailyVoiceMinutes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(readVar(env, "DEMO_DAILY_VOICE_MINUTES"));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function maxCallMinutes(env: Record<string, string | undefined> = process.env): number {
  const seconds = Number(readVar(env, "VAPI_MAX_CALL_SECONDS") ?? 480);
  return Math.ceil((Number.isFinite(seconds) && seconds > 0 ? seconds : 480) / 60);
}

export async function voiceMinutesLeft(db: Db, now: Date): Promise<number> {
  const used = await peek(db, { scope: MINUTES_SCOPE, key: "global", window: "day", now });
  return Math.max(0, dailyVoiceMinutes() - used);
}

/**
 * Open demo web calls: rows not ended, created within a call's maximum length (a call whose end report
 * never comes stops counting then). Placeholders of calls still being created count too.
 */
async function openWebCalls(db: Executor, now: Date): Promise<number> {
  const since = new Date(now.getTime() - (maxCallMinutes() + 2) * 60_000);
  return db.$count(
    calls,
    and(eq(calls.channel, "web"), eq(calls.lab, false), isNull(calls.endedAt), gt(calls.createdAt, since)),
  );
}

/** A quick check for the pre-call form (no counting); the proxy's reservation is the real gate. */
export async function checkVoiceAvailable(db: Db, now: Date): Promise<void> {
  if (dailyVoiceMinutes() === 0) throw new VoiceBusyError("off");
  if ((await voiceMinutesLeft(db, now)) < maxCallMinutes()) throw new VoiceBusyError("minutes");
  if ((await openWebCalls(db, now)) >= WEB_CALL_LIMITS.concurrent) throw new VoiceBusyError("concurrent");
}

/** Serializes line reservations, so the concurrency count and the new row can't race (SPEC §22). */
const LINES_LOCK = 0x486f6c64; // "Hold"

export type WebCallReservation = { callRowId: string; minutes: number; undo: () => Promise<void> };

/**
 * Atomically reserves a demo web call (SPEC §14.3, §22) under one advisory lock: a free line, the call's
 * maximum minutes against the global daily cap, the per-workspace and per-IP counts, and a placeholder
 * `calls` row that holds the line until Vapi answers. Any refusal rolls all of it back; `undo` gives
 * everything back when the call is never created.
 */
export async function reserveWebCall(
  db: Db,
  input: { workspaceId: string; ipKey: string; caller: { firstName: string; email: string }; now: Date },
): Promise<WebCallReservation> {
  const cap = dailyVoiceMinutes();
  if (cap === 0) throw new VoiceBusyError("off");
  const minutes = maxCallMinutes();
  const { now } = input;
  const day = (scope: string, key: string, limit: number, amount = 1) => ({
    scope,
    key,
    window: "day" as const,
    limit,
    now,
    amount,
  });
  const counts = [
    day("voice_minutes", "global", cap, minutes),
    day("web_call", input.workspaceId, WEB_CALL_LIMITS.perWorkspaceDay),
    day("web_call_ip", input.ipKey, WEB_CALL_LIMITS.perIpDay),
  ];
  const reasons = ["minutes", "workspace", "ip"] as const;

  const callRowId = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LINES_LOCK})`);
    if ((await openWebCalls(tx, now)) >= WEB_CALL_LIMITS.concurrent) throw new VoiceBusyError("concurrent");
    for (const [i, count] of counts.entries()) {
      if (!(await consume(tx, count)).ok) throw new VoiceBusyError(reasons[i]);
    }
    const [row] = await tx
      .insert(calls)
      .values({
        workspaceId: input.workspaceId,
        channel: "web",
        lab: false,
        status: "creating",
        caller: input.caller,
        voiceReservedMinutes: minutes,
        createdAt: now,
      })
      .returning({ id: calls.id });
    return row.id;
  });

  const undo = () =>
    db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(calls)
        .where(and(eq(calls.id, callRowId), isNull(calls.vapiCallId)))
        .returning({ id: calls.id });
      if (!removed) return; // already bound to a Vapi call: its end report settles it
      for (const count of counts) await consume(tx, { ...count, amount: -count.amount });
    });
  return { callRowId, minutes, undo };
}

/** Binds the placeholder to the call Vapi created (before the browser joins). */
export async function attachVapiCall(
  db: Db,
  callRowId: string,
  call: { vapiCallId: string; type: string | null; controlUrl: string | null; status: string; llmModel: string | null },
): Promise<void> {
  await db
    .update(calls)
    .set({
      vapiCallId: call.vapiCallId,
      vapiCallType: call.type,
      controlUrl: isAllowedControlUrl(call.controlUrl) ? call.controlUrl : null,
      status: call.status,
      llmModel: call.llmModel,
      updatedAt: new Date(),
    })
    .where(eq(calls.id, callRowId));
}

/**
 * Settles a demo web call's reservation with its real length, once (end-of-call report): from the
 * report's duration, else the row's own start and end, else zero for a call that never started. The
 * adjustment lands in the reservation's day bucket, against the minutes actually reserved.
 */
export async function settleWebCallMinutes(db: Db, call: typeof calls.$inferSelect): Promise<void> {
  if (call.channel !== "web" || call.lab || call.voiceReservedMinutes === null) return;
  const seconds =
    call.durationS ??
    (call.startedAt && call.endedAt ? Math.max(0, (call.endedAt.getTime() - call.startedAt.getTime()) / 1000) : 0);
  const used = Math.ceil(seconds / 60);
  const reserved = call.voiceReservedMinutes;
  await db.transaction(async (tx) => {
    // One settle per call (the report may arrive twice): a counter keyed by the call, limit 1.
    const once = await consume(tx, {
      scope: "voice_settle",
      key: call.id,
      window: "life",
      limit: 1,
      now: call.createdAt,
    });
    if (!once.ok) return;
    await consume(tx, {
      scope: "voice_minutes",
      key: "global",
      window: "day",
      limit: Number.MAX_SAFE_INTEGER,
      now: call.createdAt,
      amount: used - reserved,
    });
  });
}
