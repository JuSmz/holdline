import { eq, sql } from "drizzle-orm";

import { calls } from "@/db/schema";
import type { Executor } from "@/db/types";
import { fenceCall } from "@/server/workspaces/fence";

/**
 * A chat keeps two lists on its `calls` row (SPEC §15):
 * - `messages`: what the page shows (user and assistant lines, the payment confirmation);
 * - `gemini_contents`: the raw `Content[]` the model sees, stored verbatim with every part.
 * Both only ever grow by an atomic jsonb append, so a confirmation landing during a model turn can't
 * be lost or split a turn's function-call parts.
 */

export type ChatLine = {
  role: "user" | "assistant";
  text: string;
  at: string;
  /** A fixed payment confirmation (§16), not model output. */
  notice?: "authorized" | "declined_retry" | "expired";
};

export type GeminiPart = Record<string, unknown>;
export type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

/**
 * Appends to a chat. Returns false, and stores nothing, when the chat is gone or its demo copy was reset
 * (a turn or a payment confirmation that was still running when the visitor started a fresh demo).
 */
export async function appendChat(
  db: Executor,
  callId: string,
  add: { lines?: ChatLine[]; contents?: GeminiContent[] },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const call = await fenceCall(tx, eq(calls.id, callId), "no key update");
    if (!call || call.reset) return false;
    await tx
      .update(calls)
      .set({
        messages: sql`coalesce(${calls.messages}, '[]'::jsonb) || ${JSON.stringify(add.lines ?? [])}::jsonb`,
        geminiContents: sql`coalesce(${calls.geminiContents}, '[]'::jsonb) || ${JSON.stringify(add.contents ?? [])}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(calls.id, callId));
    return true;
  });
}

export function chatLines(row: { messages: unknown }): ChatLine[] {
  return Array.isArray(row.messages) ? (row.messages as ChatLine[]) : [];
}
