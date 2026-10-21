import { desc } from "drizzle-orm";

import { getDb } from "@/db/client";
import { vapiEvents } from "@/db/schema";
import { labAccess } from "@/server/lab";

export const dynamic = "force-dynamic";

/**
 * Downloads the latest stored Vapi payloads (already redacted on insert) as one JSON file,
 * to be saved as test fixtures. A read, so no Origin check; lab access is still required.
 */
export async function GET() {
  const access = await labAccess();
  if (access === "disabled") return new Response(null, { status: 404 });
  if (access === "login") return Response.json({ ok: false, error: "login_required" }, { status: 401 });

  const rows = await getDb().select().from(vapiEvents).orderBy(desc(vapiEvents.receivedAt)).limit(200);
  return new Response(JSON.stringify(rows.reverse(), null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="holdline-vapi-fixtures.json"',
      "Cache-Control": "no-store",
    },
  });
}
