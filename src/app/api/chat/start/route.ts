import { getDb } from "@/db/client";
import { dbErrorCode } from "@/server/db-error";
import { ChatLimitError, chatFormSchema, startChat } from "@/server/chat/session";
import { STARTER_CHIPS } from "@/server/chat/runtime";
import { tryApiGuard } from "@/server/workspaces/guard";
import { readJsonLimited } from "@/server/http/body";

export const dynamic = "force-dynamic";

/** Starts a chat for the demo workspace with the chat form's name and email (SPEC §15). */
export async function POST(request: Request) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const body = await readJsonLimited(request, 2048, chatFormSchema);
  if (body instanceof Response) return body;
  try {
    const chat = await startChat(getDb(), { workspaceId: guard.ws.id, ...body, now: new Date() });
    return Response.json({
      ok: true,
      chatId: chat.id,
      lines: [
        {
          role: "assistant",
          text: `Hi ${body.firstName}! This is ${guard.ws.name}. What can we help you with today?`,
          at: new Date().toISOString(),
        },
      ],
      chips: STARTER_CHIPS,
    });
  } catch (error) {
    if (error instanceof ChatLimitError)
      return Response.json({ ok: false, error: "limit", message: error.message }, { status: 429 });
    // A code only: the query parameters in database errors hold the visitor's name and email (§21).
    console.error(`[holdline] chat start failed: ${dbErrorCode(error)}`);
    return Response.json(
      { ok: false, error: "unavailable", message: "The chat can't start right now. Please try again." },
      { status: 503 },
    );
  }
}
