import { MAIN_WORKSPACE_ID } from "@/db/seed";
import { labApiGuard } from "@/server/lab";
import { bindWebCall } from "@/server/vapi/calls";
import { answerWebCall, createVapiWebCall } from "@/server/vapi/web-call";

export const dynamic = "force-dynamic";

/**
 * The owner lab's web-call proxy (`new Vapi("proxy", origin + "/api/vapi-proxy/lab")`, SPEC §14.3):
 * its own route, so a /try cookie never turns a lab call into a demo call or the other way round.
 */
export async function POST(request: Request) {
  const denied = await labApiGuard(request);
  if (denied) return denied;
  const created = await createVapiWebCall({ channel: "web", first_name: "Lab", email: "lab-caller@example.com" });
  if (created instanceof Response) return created;
  const { call } = created;
  return answerWebCall(created, () =>
    bindWebCall({
      workspaceId: MAIN_WORKSPACE_ID,
      vapiCallId: call.id,
      vapiCallType: call.type ?? null,
      controlUrl: call.monitor?.controlUrl ?? null,
      status: call.status ?? "queued",
      llmModel: call.assistant?.model?.model ?? null,
      lab: true,
    }),
  );
}
