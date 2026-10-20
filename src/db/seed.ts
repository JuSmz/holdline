import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { workspaces } from "./schema";

/** Fixed ID of the owner's main workspace, so seeding is idempotent across deploys. */
export const MAIN_WORKSPACE_ID = "019a0000-0000-7000-8000-000000000001";

/** Inserts the main workspace if it is missing. Never overwrites owner edits. */
export async function seedMainWorkspace(url: string): Promise<{ created: boolean }> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const inserted = await drizzle(sql)
      .insert(workspaces)
      .values({
        id: MAIN_WORKSPACE_ID,
        kind: "main",
        label: "Main",
        name: "Northside Plumbing & Electric",
        timezone: "America/Chicago",
        policy: {},
      })
      .onConflictDoNothing({ target: workspaces.id })
      .returning({ id: workspaces.id });
    return { created: inserted.length > 0 };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
