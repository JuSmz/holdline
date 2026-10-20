import { databaseUrl } from "../src/db/client";
import { seedMainWorkspace } from "../src/db/seed";

async function main() {
  const { created } = await seedMainWorkspace(databaseUrl());
  console.log(created ? "main workspace created" : "main workspace already present");
}

main().catch((error: unknown) => {
  // Print the full error incl. its `cause` chain (drizzle wraps the real Postgres/network error).
  console.error(error);
  process.exit(1);
});
