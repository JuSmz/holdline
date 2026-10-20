export const dynamic = "force-dynamic";

const HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "x-forwarded-proto",
  "x-forwarded-host",
  "forwarded",
] as const;

/**
 * TEMPORARY (stage 1, SPEC §27 R16): shows how Render's proxy sets the forwarding
 * headers, so the client-IP helper reads the right entry. Echoes only the
 * caller's own request headers. Remove once the result is recorded.
 */
export async function GET(request: Request) {
  const seen = Object.fromEntries(HEADERS.map((name) => [name, request.headers.get(name)]));
  return Response.json(seen, { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
