import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as health } from "@/app/api/health/route";
import { POST as tick } from "@/app/api/jobs/tick/route";
import { closeDb, getDb } from "@/db/client";
import { getLastTick } from "@/server/meta";

const CRON_SECRET = "c".repeat(48);

function tickRequest(authorization?: string) {
  return new Request("http://localhost/api/jobs/tick", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

afterAll(async () => {
  await closeDb();
});

describe("GET /api/health", () => {
  it("reports the database as up", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: "up" });
  });

  it("returns 503 when the database is unreachable", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost:1/nowhere_test");
    const res = await health();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, db: "down" });
  });
});

describe("POST /api/jobs/tick", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
  });

  it("rejects requests without the cron bearer token", async () => {
    expect((await tick(tickRequest())).status).toBe(401);
    expect((await tick(tickRequest("Bearer wrong-wrong-wrong-wrong-wrong-wrong"))).status).toBe(401);
  });

  it("returns 503 when CRON_SECRET is missing or too short", async () => {
    vi.stubEnv("CRON_SECRET", "short");
    expect((await tick(tickRequest("Bearer short"))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", undefined);
    expect((await tick(tickRequest("Bearer "))).status).toBe(503);
  });

  it("records the heartbeat that /api/health reports", async () => {
    const res = await tick(tickRequest(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    const { at } = (await res.json()) as { at: string };

    expect((await getLastTick(getDb()))?.toISOString()).toBe(at);
    const healthBody = (await (await health()).json()) as { lastTickAt: string };
    expect(healthBody.lastTickAt).toBe(at);
  });
});
