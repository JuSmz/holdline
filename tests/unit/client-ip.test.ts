import { describe, expect, it } from "vitest";

import { clientIp } from "@/server/security/client-ip";
import { ipHash, ipv6Prefix64 } from "@/server/security/rate-limit";

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

describe("ipHash / ipv6Prefix64", () => {
  const env = { SESSION_SECRET: "unit-test-session-secret-0123456789abcdef" };

  it("keys IPv6 by its expanded /64, whatever the compression", () => {
    expect(ipv6Prefix64("2001:db8::a:b:c:1")).toBe("2001:db8:0:0");
    expect(ipv6Prefix64("2001:db8::b:b:c:2")).toBe("2001:db8:0:0");
    expect(ipv6Prefix64("2001:db8:1::5")).toBe("2001:db8:1:0");
    expect(ipv6Prefix64("2001:0DB8:0001:0000:0001::5")).toBe("2001:db8:1:0");
    expect(ipHash("2001:db8:1:0:aaaa::1", env)).toBe(ipHash("2001:db8:1::bbbb:2", env));
    expect(ipHash("2001:db8:1:1::1", env)).not.toBe(ipHash("2001:db8:1::1", env));
  });

  it("treats IPv4-mapped addresses as IPv4 and missing ones as internal", () => {
    expect(ipHash("::ffff:1.2.3.4", env)).toBe(ipHash("1.2.3.4", env));
    expect(ipHash(null, env)).toBe("internal");
  });
});
