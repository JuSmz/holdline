import { createHmac, hkdfSync } from "node:crypto";

import { readSecret } from "@/server/config/env";

import { safeEqual } from "./compare";

/**
 * One signing helper for every token we hand out (SPEC §20). Each purpose has its own HKDF-derived
 * key and a `typ` claim, so a token minted for one purpose is rejected everywhere else.
 */
export const TOKEN_PURPOSES = ["ws-cookie", "slot", "device-link", "email-confirm", "claim", "web-caller"] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

/** Upper bounds per purpose (seconds). A `slot` token lives at most 30 minutes (SPEC §9.1). */
export const MAX_TTL_SECONDS: Record<TokenPurpose, number> = {
  "ws-cookie": 30 * 24 * 3600,
  slot: 30 * 60,
  "device-link": 24 * 3600,
  "email-confirm": 24 * 3600,
  claim: 15 * 60,
  // The pre-call form's name and email, read by the web-call proxy (SPEC §14.3).
  "web-caller": 15 * 60,
};

const VERSION = "v1";
const keys = new Map<string, Buffer>();

function keyFor(purpose: TokenPurpose, secret: string): Buffer {
  const cacheKey = `${purpose}\u0000${secret}`;
  let key = keys.get(cacheKey);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "holdline-tokens", `holdline:${VERSION}:${purpose}`, 32));
    keys.set(cacheKey, key);
  }
  return key;
}

function secretFrom(env: Record<string, string | undefined>): string {
  const secret = readSecret(env, "SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not set (at least 32 characters)");
  return secret;
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export type TokenOptions = { now?: Date; env?: Record<string, string | undefined> };

export function sign(
  purpose: TokenPurpose,
  payload: Record<string, unknown>,
  ttlSeconds: number,
  options: TokenOptions = {},
): string {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS[purpose]) {
    throw new Error(`invalid ttl for ${purpose} token`);
  }
  if ("typ" in payload || "exp" in payload) throw new Error("payload must not set typ or exp");
  const now = options.now ?? new Date();
  const body = b64(JSON.stringify({ ...payload, typ: purpose, exp: Math.floor(now.getTime() / 1000) + ttlSeconds }));
  const mac = b64(
    createHmac("sha256", keyFor(purpose, secretFrom(options.env ?? process.env)))
      .update(body)
      .digest(),
  );
  return `${VERSION}.${body}.${mac}`;
}

/** The payload (without typ/exp) if the token is intact, of this purpose, and not expired; otherwise null. */
export function verify<T extends Record<string, unknown> = Record<string, unknown>>(
  purpose: TokenPurpose,
  token: string | null | undefined,
  options: TokenOptions = {},
): T | null {
  if (!token || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, body, mac] = parts;
  const expected = b64(
    createHmac("sha256", keyFor(purpose, secretFrom(options.env ?? process.env)))
      .update(body)
      .digest(),
  );
  if (!safeEqual(mac, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const { typ, exp, ...payload } = claims as Record<string, unknown>;
  if (typ !== purpose || typeof exp !== "number") return null;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (exp <= now) return null;
  return payload as T;
}
