import { getDb } from "@/db/client";
import { conversationState } from "@/server/try/state";
import { tryApiGuard, workspaceCall, workspaceVapiCall } from "@/server/workspaces/guard";

export const dynamic = "force-dynamic";

/** Polled every 1.5 s by the call and chat pages (SPEC §16); scoped to the workspace and the call. */
export async function GET(request: Request) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const params = new URL(request.url).searchParams;
  const vapiId = params.get("vapi");
  const call = vapiId
    ? await workspaceVapiCall(guard.ws, vapiId)
    : await workspaceCall(guard.ws, params.get("call") ?? "");
  if (!call) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  return Response.json(
    { ok: true, ...(await conversationState(getDb(), guard.ws, call)) },
    { headers: { "cache-control": "no-store" } },
  );
}
