import { cookies } from "next/headers";

import { labEnabled } from "@/server/paypal";
import { ADMIN_COOKIE, isValidAdminSession } from "@/server/security/admin-session";
import { isSameOrigin } from "@/server/security/same-origin";

/** The lab exists only with LAB_ENABLED=true AND a valid owner session (SPEC §20). */
export async function labAccess(): Promise<"ok" | "disabled" | "login"> {
  if (!labEnabled()) return "disabled";
  const jar = await cookies();
  return (await isValidAdminSession(jar.get(ADMIN_COOKIE)?.value)) ? "ok" : "login";
}

/** Guard for lab API routes: 404 when disabled (don't advertise it), 401 without session, 403 cross-site. */
export async function labApiGuard(request: Request): Promise<Response | null> {
  const access = await labAccess();
  if (access === "disabled") return new Response(null, { status: 404 });
  if (access === "login") return Response.json({ ok: false, error: "login_required" }, { status: 401 });
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "bad_origin" }, { status: 403 });
  return null;
}
