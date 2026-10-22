import { z } from "zod";

import { CHAT_LIMITS, chatDeps, cleanChatText, runChatTurn } from "@/server/chat/runtime";
import { dbErrorCode } from "@/server/db-error";
import { readJsonLimited } from "@/server/http/body";
import { tryApiGuard, workspaceCall } from "@/server/workspaces/guard";

export const dynamic = "force-dynamic";

const input = z.object({
  chatId: z.uuid(),
  message: z
    .string()
    .max(CHAT_LIMITS.messageChars)
    .transform(cleanChatText)
    .pipe(z.string().min(1).max(CHAT_LIMITS.messageChars)),
});

/** One chat turn (SPEC §15): ≤ 8 KB body checked before parsing, ≤ 500 characters, cookie and Origin. */
export async function POST(request: Request) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const body = await readJsonLimited(request, CHAT_LIMITS.bodyBytes, input);
  if (body instanceof Response) return body;

  const chat = await workspaceCall(guard.ws, body.chatId);
  if (!chat || chat.channel !== "chat") return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  const deps = chatDeps();
  if (!deps) {
    return Response.json(
      { ok: false, error: "unavailable", message: "The chat isn't configured yet." },
      { status: 503 },
    );
  }
  try {
    const result = await runChatTurn(deps, chat, body.message, { ipHeaders: request.headers });
    if (!result.ok) {
      const status = { busy: 409, budget: 429, limit: 429, unavailable: 503, rephrase: 422 }[result.reason];
      return Response.json(
        { ok: false, error: result.reason, message: result.message, stored: result.stored ?? false },
        { status },
      );
    }
    return Response.json(result);
  } catch (error) {
    // A code only: database error messages carry the query parameters (transcript and PII, SPEC §21).
    console.error(`[holdline] chat turn for ${chat.id} failed: ${dbErrorCode(error)}`);
    return Response.json(
      { ok: false, error: "unavailable", message: "Something went wrong on our side. Please try again." },
      { status: 503 },
    );
  }
}
