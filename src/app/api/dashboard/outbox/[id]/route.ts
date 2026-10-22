import { getDb } from "@/db/client";
import { dbErrorCode } from "@/server/db-error";
import { emailPreview } from "@/server/dashboard/queries";
import { tryApiGuard } from "@/server/workspaces/guard";

export const dynamic = "force-dynamic";

/** One rendered outbox email for the sandboxed preview (no scripts, links open in a new tab). */
export async function GET(request: Request, ctx: RouteContext<"/api/dashboard/outbox/[id]">) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  try {
    const email = await emailPreview(getDb(), guard.ws, (await ctx.params).id, new Date());
    if (!email) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    return Response.json({ ok: true, ...email }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error(`[holdline] outbox preview failed: ${dbErrorCode(error)}`);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
