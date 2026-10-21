import { describe, expect, it } from "vitest";

import { centsToPayPal, formatUsd, payPalToCents } from "@/server/money";

describe("money", () => {
  it.each([
    [0, "0.00"],
    [5, "0.05"],
    [2500, "25.00"],
    [14900, "149.00"],
    [14999, "149.99"],
  ])("centsToPayPal(%i) = %s", (cents, value) => {
    expect(centsToPayPal(cents)).toBe(value);
    expect(payPalToCents(value)).toBe(cents);
  });

  it("parses short forms", () => {
    expect(payPalToCents("149")).toBe(14900);
    expect(payPalToCents("149.5")).toBe(14950);
  });

  it.each(["-1.00", "1.234", "abc", "", "1e3", "12.3.4"])("rejects %s", (value) => {
    expect(() => payPalToCents(value)).toThrow();
  });

  it("rejects fractional or negative cents", () => {
    expect(() => centsToPayPal(1.5)).toThrow();
    expect(() => centsToPayPal(-100)).toThrow();
  });

  it("formats for display", () => {
    expect(formatUsd(4900)).toBe("$49.00");
  });
});
