import { describe, expect, it } from "vitest";

import { bearerMatches, safeEqual } from "@/server/security/compare";

const SECRET = "s".repeat(40);

describe("safeEqual", () => {
  it("compares exactly", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("bearerMatches", () => {
  it("accepts the exact bearer token", () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects wrong, missing or malformed headers", () => {
    expect(bearerMatches(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(bearerMatches(null, SECRET)).toBe(false);
    expect(bearerMatches(SECRET, SECRET)).toBe(false);
    expect(bearerMatches(`Basic ${SECRET}`, SECRET)).toBe(false);
  });

  it("never authenticates against an empty or short expected secret", () => {
    expect(bearerMatches("Bearer ", "")).toBe(false);
    expect(bearerMatches("Bearer short", "short")).toBe(false);
    expect(bearerMatches(`Bearer ${SECRET}`, undefined)).toBe(false);
  });
});
