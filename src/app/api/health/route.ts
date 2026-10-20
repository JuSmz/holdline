import { getDb } from "@/db/client";
import { getLastTick, pingDb } from "@/server/meta";

export const dynamic = "force-dynamic";

/** Render health check. 503 when the database is unreachable, so a broken deploy never goes live. */
export async function GET() {
  let dbUp = false;
  let lastTickAt: string | null = null;
  try {
    const db = getDb();
    dbUp = await pingDb(db);
    if (dbUp) lastTickAt = (await getLastTick(db))?.toISOString() ?? null;
  } catch {
    dbUp = false;
  }

  const body = {
    ok: dbUp,
    db: dbUp ? "up" : "down",
    lastTickAt,
    version: process.env.npm_package_version ?? "dev",
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
    paypalEnv: process.env.PAYPAL_ENV ?? null,
  };
  return Response.json(body, {
    status: dbUp ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
