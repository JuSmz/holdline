import postgres from "postgres";

import { runMigrations } from "../../src/db/migrate";
import { seedMainWorkspace } from "../../src/db/seed";

const E2E_DATABASE_URL = process.env.DATABASE_URL_E2E ?? "postgres://postgres@localhost:55433/holdline_e2e";

/**
 * Runs before the e2e server starts (Playwright starts webServer before globalSetup): its own database,
 * never the dev data; created if needed, migrated, seeded, rate limits cleared.
 */
async function setup() {
  const target = new URL(E2E_DATABASE_URL);
  const dbName = target.pathname.replace(/^\//, "");
  if (!dbName.includes("e2e")) throw new Error(`Refusing to run e2e tests against "${dbName}".`);
  const admin = new URL(E2E_DATABASE_URL);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const exists = await sql`select 1 from pg_database where datname = ${dbName}`;
    if (exists.length === 0) await sql.unsafe(`create database "${dbName.replace(/"/g, "")}"`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  await runMigrations(E2E_DATABASE_URL);
  await seedMainWorkspace(E2E_DATABASE_URL);
  const db = postgres(E2E_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await db`truncate rate_counters`;
  } finally {
    await db.end({ timeout: 5 });
  }
}

setup().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
