/** A scriptable fetch double for PayPal client tests. */

export type Recorded = { method: string; url: string; headers: Record<string, string>; body: unknown };

type Responder = (req: Recorded) => Response | Promise<Response> | Error;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function fakeFetch(routes: { match: (req: Recorded) => boolean; respond: Responder }[]) {
  const calls: Recorded[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    let body: unknown = init?.body;
    if (typeof body === "string" && headers["Content-Type"] === "application/json") body = JSON.parse(body);
    const req: Recorded = { method: init?.method ?? "GET", url: String(input), headers, body };
    calls.push(req);
    const route = routes.find((r) => r.match(req));
    if (!route) throw new Error(`no fake route for ${req.method} ${req.url}`);
    const result = await route.respond(req);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const tokenRoute = {
  match: (req: Recorded) => req.url.endsWith("/v1/oauth2/token"),
  respond: () => json(200, { access_token: "test-token", expires_in: 32400 }),
};
