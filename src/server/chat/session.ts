import { randomBytes } from "node:crypto";

import { z } from "zod";

import { calls } from "@/db/schema";
import type { Db } from "@/db/types";
import { cleanFirstName } from "@/server/email/templates";
import { consume } from "@/server/security/rate-limit";

/** The chat form (SPEC §15): a first name and an email that override tool arguments (§13.3). */
export const chatFormSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .transform((s) => cleanFirstName(s)),
  email: z.string().trim().toLowerCase().pipe(z.email().max(120)),
});

export const CHATS_PER_WORKSPACE_DAY = 12;

export class ChatLimitError extends Error {
  constructor() {
    super("This demo copy has started too many chats today.");
    this.name = "ChatLimitError";
  }
}

/** A new chat conversation: a `calls` row with channel chat, bound to the demo workspace. */
export async function startChat(
  db: Db,
  input: { workspaceId: string; firstName: string; email: string; now: Date },
): Promise<typeof calls.$inferSelect> {
  const limit = await consume(db, {
    scope: "chat_start",
    key: input.workspaceId,
    window: "day",
    limit: CHATS_PER_WORKSPACE_DAY,
    now: input.now,
  });
  if (!limit.ok) throw new ChatLimitError();
  const [row] = await db
    .insert(calls)
    .values({
      workspaceId: input.workspaceId,
      channel: "chat",
      chatSessionId: randomBytes(16).toString("base64url"),
      status: "in-progress",
      startedAt: input.now,
      caller: { firstName: input.firstName, email: input.email },
      messages: [],
      geminiContents: [],
    })
    .returning();
  return row;
}
