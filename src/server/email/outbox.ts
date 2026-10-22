import { createHmac } from "node:crypto";

import { outboxEmails } from "@/db/schema";
import type { Executor } from "@/db/types";
import { readSecret } from "@/server/config/env";

import type { RenderedEmail } from "./templates";

export function emailHmac(email: string, env: Record<string, string | undefined> = process.env): string {
  const secret = readSecret(env, "SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(`email:${email.trim().toLowerCase()}`).digest("base64url");
}

/**
 * Writes an email to the outbox inside the caller's transaction (SPEC §19), deduplicated by a
 * deterministic idempotency key. Stage 7 keeps every mail `outbox_only` (visible in the Outbox);
 * real delivery through Resend, with confirmed recipients only, arrives in stage 8.
 */
export async function queueEmail(
  db: Executor,
  input: { workspaceId: string; bookingId: string | null; idempotencyKey: string; to: string; email: RenderedEmail },
): Promise<void> {
  await db
    .insert(outboxEmails)
    .values({
      idempotencyKey: input.idempotencyKey,
      workspaceId: input.workspaceId,
      bookingId: input.bookingId,
      toHmac: emailHmac(input.to),
      to: null,
      template: input.email.template,
      subject: input.email.subject,
      html: input.email.html,
      status: "outbox_only",
    })
    .onConflictDoNothing({ target: outboxEmails.idempotencyKey });
}
