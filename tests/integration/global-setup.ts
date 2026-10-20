import postgres from "postgres";

import { runMigrations } from "../../src/db/migrate";

const url = process.env.DATABASE_URL_TEST ?? "postgres://postgres@localhost:55433/holdline_test";

/** Creates the test database if needed and applies the production migrations to it. */
export default async function setup() {
  const target = new URL(url);
  const dbName = target.pathname.replace(/^\//, "");
  if (!dbName.includes("test")) {
    throw new Error(`Refusing to run integration tests against "${dbName}": the database name must contain "test".`);
  }

  const admin = new URL(url);
  admin.pathname = "/postgres";
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const exists = await sql`select 1 from pg_database where datname = ${dbName}`;
    if (exists.length === 0) await sql.unsafe(`create database "${dbName.replace(/"/g, "")}"`);
  } finally {
    await sql.end({ timeout: 5 });
  }

  await runMigrations(url);
}
