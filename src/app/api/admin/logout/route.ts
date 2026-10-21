import { ADMIN_COOKIE, deleteAdminSession } from "@/server/security/admin-session";
import { readCookie } from "@/server/security/cookies";
import { isSameOrigin } from "@/server/security/same-origin";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "bad_origin" }, { status: 403 });
  await deleteAdminSession(readCookie(request, ADMIN_COOKIE));
  // A __Host- cookie can only be overwritten/deleted with the same Secure + Path=/ attributes.
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${ADMIN_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
