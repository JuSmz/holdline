import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as login } from "@/app/api/admin/login/route";
import { POST as logout } from "@/app/api/admin/logout/route";
import { closeDb } from "@/db/client";
import { ADMIN_COOKIE, isValidAdminSession } from "@/server/security/admin-session";

const TOKEN = "t".repeat(44);
const ORIGIN = "http://localhost:3000";
let ipCounter = 0;

function loginRequest(form: Record<string, string>, init: { origin?: string | null; contentType?: string } = {}) {
  const headers: Record<string, string> = {
    host: "localhost:3000",
    "content-type": init.contentType ?? "application/x-www-form-urlencoded",
    // A distinct client IP per request keeps the per-IP limiter out of the way.
    "cf-connecting-ip": `198.51.100.${(ipCounter++ % 250) + 1}`,
  };
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  return new Request(`${ORIGIN}/api/admin/login`, {
    method: "POST",
    headers,
    body: new URLSearchParams(form).toString(),
  });
}

beforeEach(() => {
  vi.stubEnv("ADMIN_TOKEN", TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await closeDb();
});

describe("POST /api/admin/login", () => {
  it("rejects cross-site and missing Origin", async () => {
    expect((await login(loginRequest({ token: TOKEN }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await login(loginRequest({ token: TOKEN }, { origin: null }))).status).toBe(403);
  });

  it("only accepts a small urlencoded form", async () => {
    expect((await login(loginRequest({ token: TOKEN }, { contentType: "application/json" }))).status).toBe(415);
    expect((await login(loginRequest({ token: "x".repeat(5000) }))).status).toBe(413);
  });

  it("redirects back with an error on a wrong token and sets no cookie", async () => {
    const res = await login(loginRequest({ token: "wrong", next: "/lab/paypal" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/login?error=1&next=%2Flab%2Fpaypal");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses everything when ADMIN_TOKEN is missing or short", async () => {
    vi.stubEnv("ADMIN_TOKEN", "short");
    const res = await login(loginRequest({ token: "short" }));
    expect(res.headers.get("location")).toContain("error=1");
  });

  it("creates a hashed server-side session and a __Host- cookie on the right token", async () => {
    const res = await login(loginRequest({ token: TOKEN, next: "/lab/paypal" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/lab/paypal");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${ADMIN_COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    const id = cookie.split(";")[0].split("=")[1];
    expect(await isValidAdminSession(id)).toBe(true);

    const out = await logout(
      new Request(`${ORIGIN}/api/admin/logout`, {
        method: "POST",
        headers: { host: "localhost:3000", origin: ORIGIN, cookie: `${ADMIN_COOKIE}=${id}` },
      }),
    );
    expect(out.status).toBe(303);
    const cleared = out.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Secure");
    expect(cleared).toContain("Path=/");
    expect(await isValidAdminSession(id)).toBe(false);
  });

  it("never redirects off-site via `next`", async () => {
    for (const next of ["//evil.example", "https://evil.example", "/\\evil"]) {
      const res = await login(loginRequest({ token: TOKEN, next }));
      expect(res.headers.get("location")).toBe("/lab/paypal");
    }
  });
});
