import { getDb } from "@/db/client";
import { chatFormSchema } from "@/server/chat/session";
import {
  CALLER_COOKIE,
  CALLER_COOKIE_TTL_SECONDS,
  callerCookieValue,
  checkVoiceAvailable,
  VoiceBusyError,
} from "@/server/try/web-call";
import { tryApiGuard } from "@/server/workspaces/guard";
import { readJsonLimited } from "@/server/http/body";

export const dynamic = "force-dynamic";

/**
 * The pre-call form (SPEC §14.3, §16): stores the name and email in a short signed cookie that only
 * the web-call proxy reads, and says up front whether the voice line has room today.
 */
export async function POST(request: Request) {
  const guard = await tryApiGuard(request);
  if (guard instanceof Response) return guard;
  const body = await readJsonLimited(request, 2048, chatFormSchema);
  if (body instanceof Response) return body;
  try {
    await checkVoiceAvailable(getDb(), new Date());
  } catch (error) {
    if (error instanceof VoiceBusyError) {
      return Response.json(
        { ok: false, error: "voice_busy", reason: error.reason, message: error.message },
        { status: 429 },
      );
    }
    throw error;
  }
  const value = callerCookieValue({ ws: guard.ws.id, ...body });
  const response = Response.json({ ok: true });
  response.headers.append(
    "set-cookie",
    `${CALLER_COOKIE}=${value}; Path=/; Max-Age=${CALLER_COOKIE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
  );
  return response;
}
