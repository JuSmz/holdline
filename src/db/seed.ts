import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { BUSINESS, seedCatalog } from "./seed-data";
import * as schema from "./schema";
import { workspaces } from "./schema";

/** Fixed ID of the owner's main workspace, so seeding is idempotent across deploys. */
export const MAIN_WORKSPACE_ID = "019a0000-0000-7000-8000-000000000001";

/**
 * Inserts the main workspace and its catalog if they are missing (SPEC §17). Idempotent: runs on every
 * deploy, never overwrites owner edits, only fills in technician payout emails once env has them.
 */
export async function seedMainWorkspace(
  url: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ created: boolean }> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await drizzle(sql, { schema }).transaction(async (tx) => {
      const inserted = await tx
        .insert(workspaces)
        .values({
          id: MAIN_WORKSPACE_ID,
          kind: "main",
          label: "Main",
          name: BUSINESS.name,
          timezone: BUSINESS.timezone,
          policy: {},
        })
        .onConflictDoNothing({ target: workspaces.id })
        .returning({ id: workspaces.id });
      await seedCatalog(tx, MAIN_WORKSPACE_ID, env);
      return { created: inserted.length > 0 };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
