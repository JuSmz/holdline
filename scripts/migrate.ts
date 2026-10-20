import { databaseUrl } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";

async function main() {
  await runMigrations(databaseUrl());
  console.log("migrations applied");
}

main().catch((error: unknown) => {
  // Print the full error incl. its `cause` chain (drizzle wraps the real Postgres/network error).
  console.error(error);
  process.exit(1);
});
