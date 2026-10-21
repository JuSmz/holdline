/**
 * CSRF guard for cookie-authenticated route handlers (SPEC §20). Server Actions get Next's
 * own Origin check; route handlers use this. The browser's Origin must match the host the
 * request was sent to.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
