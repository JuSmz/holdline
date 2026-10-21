/**
 * The real client IP on Render (verified 2026-10-21, SPEC §20 / R16).
 *
 * Render sits behind Cloudflare. Cloudflare APPENDS to a client-supplied X-Forwarded-For
 * (so its leftmost entry is forgeable) but OVERWRITES CF-Connecting-IP and True-Client-IP
 * with the address it actually saw. We therefore never read X-Forwarded-For.
 * Returns null for requests without these headers (local dev, Render private network).
 */
export function clientIp(headers: Headers): string | null {
  for (const name of ["cf-connecting-ip", "true-client-ip"]) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return null;
}
