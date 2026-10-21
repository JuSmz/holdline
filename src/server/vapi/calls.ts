import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import { getDb } from "@/db/client";
import { calls, vapiEvents } from "@/db/schema";
import { dbErrorCode } from "@/server/db-error";

import { isAllowedControlUrl } from "./control";
import { redactForFixture, type CallReport } from "./messages";

export type CallBinding = typeof calls.$inferSelect;

/** Stores a payload as a fixture (redacted). Failures are logged, never thrown: fixtures must not break a call. */
export async function recordVapiEvent(input: {
  endpoint: "events" | "tools" | "proxy";
  messageType: string;
  vapiCallId?: string | null;
  callType?: string | null;
  payload: unknown;
}): Promise<void> {
  try {
    await getDb()
      .insert(vapiEvents)
      .values({
        endpoint: input.endpoint,
        messageType: input.messageType.slice(0, 100),
        vapiCallId: input.vapiCallId?.slice(0, 100) ?? null,
        callType: input.callType?.slice(0, 50) ?? null,
        payload: redactForFixture(input.payload),
      });
  } catch (error) {
    console.error(
      `[holdline] could not store Vapi event ${input.messageType} for ${input.vapiCallId ?? "?"}: ${dbErrorCode(error)}`,
    );
  }
}

export async function findCallBinding(vapiCallId: string | undefined): Promise<CallBinding | undefined> {
  if (!vapiCallId) return undefined;
  const [row] = await getDb().select().from(calls).where(eq(calls.vapiCallId, vapiCallId)).limit(1);
  return row;
}

export async function bindWebCall(input: {
  workspaceId: string;
  vapiCallId: string;
  vapiCallType: string | null;
  controlUrl: string | null;
  status: string;
  llmModel: string | null;
  lab: boolean;
}): Promise<void> {
  await getDb()
    .insert(calls)
    .values({
      workspaceId: input.workspaceId,
      channel: "web",
      vapiCallId: input.vapiCallId,
      vapiCallType: input.vapiCallType,
      controlUrl: isAllowedControlUrl(input.controlUrl) ? input.controlUrl : null,
      status: input.status,
      llmModel: input.llmModel,
      lab: input.lab,
    });
}

/** Keeps the first allowed controlUrl we learn (create response, webhook or GET /call). */
export async function rememberControlUrl(vapiCallId: string, controlUrl: string | undefined): Promise<void> {
  if (!isAllowedControlUrl(controlUrl)) return;
  await getDb()
    .update(calls)
    .set({ controlUrl, updatedAt: new Date() })
    .where(and(eq(calls.vapiCallId, vapiCallId), isNull(calls.controlUrl)));
}

/** Applies a status-update. Deliveries can arrive out of order, so nothing moves a call out of `ended`. */
export async function applyCallStatus(vapiCallId: string, status: string, controlUrl: string | undefined) {
  const set: PgUpdateSetSource<typeof calls> = { updatedAt: new Date() };
  if (status === "ended") {
    set.status = "ended";
    set.endedAt = sql`coalesce(${calls.endedAt}, now())`;
  } else {
    set.status = sql`case when ${calls.status} = 'ended' then ${calls.status} else ${status} end`;
  }
  if (status === "in-progress") set.startedAt = sql`coalesce(${calls.startedAt}, now())`;
  await getDb().update(calls).set(set).where(eq(calls.vapiCallId, vapiCallId));
  await rememberControlUrl(vapiCallId, controlUrl);
}

/** Stores the end-of-call report. A repeated report overwrites with the same data. */
export async function applyCallReport(vapiCallId: string, report: CallReport): Promise<void> {
  await getDb()
    .update(calls)
    .set({
      status: "ended",
      endedReason: report.endedReason,
      costCents: report.costCents,
      startedAt: report.startedAt ?? undefined,
      endedAt: report.endedAt ?? new Date(),
      durationS: report.durationS,
      transcript: report.transcript,
      messages: report.messages,
      metrics: report.metrics,
      llmModel: report.llmModel ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(calls.vapiCallId, vapiCallId));
}

/** Lab calls only: the notify route never acts on a call the lab didn't start. */
export async function findLabCall(vapiCallId: string): Promise<CallBinding | undefined> {
  const [row] = await getDb()
    .select()
    .from(calls)
    .where(and(eq(calls.vapiCallId, vapiCallId), eq(calls.lab, true), ne(calls.status, "ended")))
    .limit(1);
  return row;
}
