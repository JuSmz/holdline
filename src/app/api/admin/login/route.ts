import { readSecret } from "@/server/config/env";
import { readBodyLimited } from "@/server/paypal/webhooks";
import { ADMIN_COOKIE, adminCookieOptions, createAdminSession } from "@/server/security/admin-session";
import { clientIp } from "@/server/security/client-ip";
import { safeEqual } from "@/server/security/compare";
import { MemoryRateLimiter } from "@/server/security/memory-rate-limit";
import { isSameOrigin } from "@/server/security/same-origin";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4096;
const perIp = new MemoryRateLimiter(5, 60_000);
/** Generous: ADMIN_TOKEN is 256-bit, so this only bounds floods; per-IP is checked first so one IP can't lock out the owner. */
const global = new MemoryRateLimiter(100, 60_000);

/** Only same-site relative paths, never `//evil` or absolute URLs. */
function safeNext(value: string | null): string {
  const next = value ?? "";
  return /^\/(?!\/)[\w\-/]*$/.test(next) ? next : "/lab/paypal";
}

/** 303 to a same-site relative path (a relative Location keeps the public host behind the proxy). */
function redirect(path: string, headers: Headers = new Headers()) {
  headers.set("Location", path);
  return new Response(null, { status: 303, headers });
}

/** POST /api/admin/login — owner login with ADMIN_TOKEN (SPEC §20). Never via query string. */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ ok: false, error: "bad_origin" }, { status: 403 });
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return Response.json({ ok: false, error: "unsupported_media_type" }, { status: 415 });
  }

  const ip = clientIp(request.headers) ?? "internal";
  if (!perIp.take(ip) || !global.take("login")) {
    return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  const body = await readBodyLimited(request, MAX_BODY_BYTES);
  if (!body) return Response.json({ ok: false, error: "body_too_large" }, { status: 413 });
  const form = new URLSearchParams(new TextDecoder().decode(body));
  const token = form.get("token") ?? "";
  const next = safeNext(form.get("next"));

  const expected = readSecret(process.env, "ADMIN_TOKEN");
  if (!expected || token.length > 256 || !safeEqual(token, expected)) {
    return redirect(`/admin/login?error=1&next=${encodeURIComponent(next)}`);
  }

  const session = await createAdminSession();
  const opts = adminCookieOptions(session.expiresAt);
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${session.id}; Path=${opts.path}; Expires=${opts.expires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`,
  );
  return redirect(next, headers);
}
