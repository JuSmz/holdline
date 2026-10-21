import { describe, expect, it } from "vitest";

import { clientIp } from "@/server/security/client-ip";

describe("clientIp", () => {
  it("uses CF-Connecting-IP, then True-Client-IP", () => {
    expect(clientIp(new Headers({ "cf-connecting-ip": "203.0.113.7", "true-client-ip": "198.51.100.1" }))).toBe(
      "203.0.113.7",
    );
    expect(clientIp(new Headers({ "true-client-ip": "198.51.100.1" }))).toBe("198.51.100.1");
  });

  it("never trusts X-Forwarded-For (Cloudflare appends to a forged value)", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7, 172.69.109.46" }))).toBeNull();
  });

  it("returns null for internal requests", () => {
    expect(clientIp(new Headers())).toBeNull();
  });
});
