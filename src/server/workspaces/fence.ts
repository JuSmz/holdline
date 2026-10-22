import { eq, type SQL } from "drizzle-orm";

import { calls, workspaces } from "@/db/schema";
import type { Tx } from "@/db/types";

export type FencedCall = { id: string; workspaceId: string; reset: boolean };

/**
 * The reset fence (SPEC §17, §21) for a late write into one conversation: a Vapi report or event, a
 * chat line, a summary, a booking from a tool call. Call it inside the writer's transaction, before the
 * write. It locks the calls row, then reads the copy's `reset_at` in a statement of its own.
 *
 * The reset purge (reset.ts) locks every conversation of the copy FOR UPDATE before it clears
 * anything. So a write either commits before the purge reaches that row, and the purge clears it, or
 * it waits for the purge to commit and then sees `reset_at` (READ COMMITTED: the next statement takes
 * a new snapshot). A writer that sees `reset: true` keeps no PII.
 *
 * `key share` is enough for writes into other tables, since it waits only for the purge's lock;
 * `no key update` is for writes into the calls row itself. Returns null for an unknown call.
 */
export async function fenceCall(
  tx: Tx,
  where: SQL | undefined,
  lock: "no key update" | "key share",
): Promise<FencedCall | null> {
  const [row] = await tx
    .select({ id: calls.id, workspaceId: calls.workspaceId })
    .from(calls)
    .where(where)
    .limit(1)
    .for(lock);
  if (!row) return null;
  const [ws] = await tx
    .select({ resetAt: workspaces.resetAt })
    .from(workspaces)
    .where(eq(workspaces.id, row.workspaceId));
  return { ...row, reset: ws?.resetAt != null };
}
