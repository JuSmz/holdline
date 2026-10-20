import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { workspaces } from "@/db/schema";
import { MAIN_WORKSPACE_ID, seedMainWorkspace } from "@/db/seed";

afterAll(async () => {
  await closeDb();
});

describe("seedMainWorkspace", () => {
  it("is idempotent and never overwrites an existing main workspace", async () => {
    const url = process.env.DATABASE_URL!;
    await seedMainWorkspace(url);

    const db = getDb();
    await db.update(workspaces).set({ name: "Owner renamed" }).where(eq(workspaces.id, MAIN_WORKSPACE_ID));

    const second = await seedMainWorkspace(url);
    expect(second.created).toBe(false);

    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, MAIN_WORKSPACE_ID));
    expect(row).toMatchObject({ kind: "main", name: "Owner renamed", timezone: "America/Chicago" });

    // Restore for other tests / reruns.
    await db
      .update(workspaces)
      .set({ name: "Northside Plumbing & Electric" })
      .where(eq(workspaces.id, MAIN_WORKSPACE_ID));
  });

  it("generates UUIDv7 ids in the database", async () => {
    const db = getDb();
    const [row] = await db
      .insert(workspaces)
      .values({ kind: "demo", label: "#test", name: "Test", timezone: "America/Chicago" })
      .returning({ id: workspaces.id });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await db.delete(workspaces).where(eq(workspaces.id, row.id));
  });
});
