import { readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { STANDARD_HOURS } from "@/db/seed-data";
import { findSlots, readSlotId, slotId, windowsOn } from "@/server/domain/availability";
import {
  BOOKING_STATUSES,
  canSetFlag,
  canTransition,
  conflictMessage,
  FLAG_STATUSES,
  isTerminal,
  PAYMENT_ISSUES,
  STATUS_RANK,
} from "@/server/domain/booking-state";
import { DEFAULT_POLICY, isLateCancellation, policyOf } from "@/server/domain/policy";
import { extraWorkLines, payoutCents, priceSnapshot } from "@/server/domain/pricing";
import { reauthorizeAt, honorUntil } from "@/server/domain/reauth";
import { BOOKING_REF, newBookingRef } from "@/server/domain/refs";
import { isoWeekday, localDate, slotLabel, zonedToUtc } from "@/server/domain/time";
import { sign, TOKEN_PURPOSES, verify } from "@/server/security/tokens";

const ENV = { SESSION_SECRET: "s".repeat(48) };

describe("state machine tables (SPEC §8)", () => {
  const ALLOWED = [
    "pending_payment>authorized",
    "pending_payment>expired",
    "authorized>completed",
    "authorized>no_show",
    "authorized>cancelled",
    "completed>captured",
    "no_show>captured",
    "no_show>voided",
    "cancelled>voided",
    "cancelled>captured",
    "captured>paid_out",
  ];

  it("allows exactly the §8.2 pairs, each strictly increasing the rank", () => {
    const allowed: string[] = [];
    for (const from of BOOKING_STATUSES) {
      for (const to of BOOKING_STATUSES) {
        if (!canTransition(from, to)) continue;
        allowed.push(`${from}>${to}`);
        expect(STATUS_RANK[to]).toBeGreaterThan(STATUS_RANK[from]);
      }
    }
    expect(allowed.sort()).toEqual([...ALLOWED].sort());
  });

  it("matches the database trigger pair for pair", () => {
    const sql = readFileSync(path.join(import.meta.dirname, "../../drizzle/0004_status_guards.sql"), "utf8");
    const bookingFn = sql.slice(sql.indexOf("holdline_booking_guard"), sql.indexOf("holdline_invoice_guard"));
    const pairs = [...bookingFn.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}>${m[2]}`);
    expect(pairs.sort()).toEqual([...ALLOWED].sort());
  });

  it("has terminal states exactly where nothing follows", () => {
    expect(BOOKING_STATUSES.filter(isTerminal).sort()).toEqual(["expired", "paid_out", "voided"]);
  });

  it("allows each flag only in the statuses of SPEC §8.3", () => {
    const SPEC_FLAGS = {
      authorization_pending: ["pending_payment"],
      reauth_failed: ["authorized"],
      hold_lost: ["authorized"],
      capture_failed: ["completed", "no_show", "cancelled", "captured"],
      capture_pending: ["captured"],
      payout_failed: ["captured"],
    };
    for (const flag of PAYMENT_ISSUES) {
      expect([...FLAG_STATUSES[flag]].sort()).toEqual([...SPEC_FLAGS[flag]].sort());
      for (const status of BOOKING_STATUSES) {
        expect(canSetFlag(status, flag)).toBe(SPEC_FLAGS[flag].includes(status));
      }
    }
  });

  it("gives every status a visible conflict message", () => {
    for (const status of BOOKING_STATUSES) expect(conflictMessage(status)).toMatch(/\w/);
    expect(conflictMessage("no_show")).toBe("Already marked as no-show.");
  });

  // The money and rank property over the real services and database lives in
  // tests/integration/payments-property.test.ts (SPEC §8.5).
});

describe("pricing and payout math (SPEC §9.1)", () => {
  it("snapshots the price and rejects nonsense", () => {
    expect(priceSnapshot({ name: "Drain cleaning", priceCents: 14_900, noShowFeeCents: 4_900 })).toEqual({
      serviceName: "Drain cleaning",
      priceCents: 14_900,
      noShowFeeCents: 4_900,
      currency: "USD",
    });
    expect(() => priceSnapshot({ name: "x", priceCents: 0, noShowFeeCents: 0 })).toThrow();
    expect(() => priceSnapshot({ name: "x", priceCents: 100, noShowFeeCents: 200 })).toThrow();
    expect(() => priceSnapshot({ name: "x", priceCents: 10.5, noShowFeeCents: 0 })).toThrow();
  });

  it("floors the technician share, never over-pays", () => {
    expect(payoutCents(14_900, 6_000)).toBe(8_940);
    expect(payoutCents(4_999, 6_000)).toBe(2_999); // 2999.4 → 2999
    expect(payoutCents(1, 6_000)).toBe(0);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: 0, max: 10_000 }), (cents, bps) => {
        const p = payoutCents(cents, bps);
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeLessThanOrEqual(cents);
        expect(p * 10_000).toBeLessThanOrEqual(cents * bps);
      }),
    );
    expect(() => payoutCents(100, 10_001)).toThrow();
  });

  const addons = [
    { id: "a1", key: "shutoff-valve", name: "Replace shut-off valve", unitPriceCents: 2_500, active: true },
    { id: "a2", key: "extra-labor", name: "Extra labor (30 min)", unitPriceCents: 4_500, active: true },
    { id: "a3", key: "old", name: "Retired", unitPriceCents: 1_000, active: false },
  ];

  it("builds extra-work lines from add-ons only, quantities 1–20, total ≤ $2,000", () => {
    expect(
      extraWorkLines(addons, [
        { addonId: "a1", quantity: 2 },
        { addonId: "a2", quantity: 1 },
      ]),
    ).toEqual({
      lines: [
        { key: "shutoff-valve", name: "Replace shut-off valve", quantity: 2, unitAmountCents: 2_500 },
        { key: "extra-labor", name: "Extra labor (30 min)", quantity: 1, unitAmountCents: 4_500 },
      ],
      totalCents: 9_500,
    });
    expect(() => extraWorkLines(addons, [{ addonId: "a1", quantity: 0 }])).toThrow();
    expect(() => extraWorkLines(addons, [{ addonId: "a1", quantity: 21 }])).toThrow();
    expect(() => extraWorkLines(addons, [{ addonId: "a1", quantity: 1.5 }])).toThrow();
    expect(() => extraWorkLines(addons, [{ addonId: "a3", quantity: 1 }])).toThrow();
    expect(() => extraWorkLines(addons, [{ addonId: "nope", quantity: 1 }])).toThrow();
    expect(() =>
      extraWorkLines(addons, [
        { addonId: "a1", quantity: 1 },
        { addonId: "a1", quantity: 1 },
      ]),
    ).toThrow();
    expect(() => extraWorkLines(addons, [])).toThrow();
    const pricey = [{ id: "p", key: "p", name: "p", unitPriceCents: 150_000, active: true }];
    expect(() => extraWorkLines(pricey, [{ addonId: "p", quantity: 2 }])).toThrow();
  });
});

describe("policy", () => {
  it("defaults and caps the booking window at 14 days", () => {
    expect(policyOf(null)).toEqual(DEFAULT_POLICY);
    expect(policyOf({ bookingWindowDays: 30 }).bookingWindowDays).toBe(14);
  });

  it("calls a cancellation late inside the window", () => {
    const policy = policyOf({});
    const slot = new Date("2026-10-30T15:00:00Z");
    expect(isLateCancellation(policy, slot, new Date("2026-10-29T15:00:01Z"))).toBe(true);
    expect(isLateCancellation(policy, slot, new Date("2026-10-29T15:00:00Z"))).toBe(false);
  });
});

describe("reauthorization schedule (SPEC §12)", () => {
  const authorizedAt = new Date("2026-10-22T15:00:00Z");
  const honor = honorUntil(authorizedAt);

  it("needs none when the job ends inside the honor period", () => {
    expect(honor.toISOString()).toBe("2026-10-25T15:00:00.000Z");
    expect(reauthorizeAt({ authorizedAt, honorUntil: honor, slotEnd: new Date("2026-10-24T15:00:00Z") })).toBeNull();
  });

  it("reauthorizes a day before a job on day 10", () => {
    const slotEnd = new Date("2026-11-01T17:00:00Z");
    expect(reauthorizeAt({ authorizedAt, honorUntil: honor, slotEnd })?.toISOString()).toBe("2026-10-31T17:00:00.000Z");
  });

  it("never before day 3 + 1 h, never after day 28", () => {
    const soon = reauthorizeAt({ authorizedAt, honorUntil: honor, slotEnd: new Date("2026-10-25T20:00:00Z") });
    expect(soon?.toISOString()).toBe("2026-10-25T16:00:00.000Z");
    const far = reauthorizeAt({ authorizedAt, honorUntil: honor, slotEnd: new Date("2026-12-31T00:00:00Z") });
    expect(far?.toISOString()).toBe("2026-11-19T15:00:00.000Z");
  });
});

describe("time zone and slots, including the US DST change on 2026-11-01", () => {
  const TZ = "America/Chicago";

  it("converts wall time to UTC on both sides of the change", () => {
    expect(zonedToUtc("2026-10-30", "08:00", TZ).toISOString()).toBe("2026-10-30T13:00:00.000Z"); // CDT, UTC−5
    expect(zonedToUtc("2026-11-02", "08:00", TZ).toISOString()).toBe("2026-11-02T14:00:00.000Z"); // CST, UTC−6
    expect(zonedToUtc("2026-11-01", "12:00", TZ).toISOString()).toBe("2026-11-01T18:00:00.000Z");
    expect(localDate(new Date("2026-11-02T05:30:00Z"), TZ)).toBe("2026-11-01");
    expect(isoWeekday("2026-11-01")).toBe(7);
    expect(isoWeekday("2026-11-02")).toBe(1);
  });

  it("generates 2-hour windows from the working hours", () => {
    expect(windowsOn(STANDARD_HOURS, "2026-10-30", TZ).map((w) => w.start.toISOString())).toEqual([
      "2026-10-30T13:00:00.000Z",
      "2026-10-30T15:00:00.000Z",
      "2026-10-30T17:00:00.000Z",
      "2026-10-30T19:00:00.000Z",
      "2026-10-30T21:00:00.000Z",
    ]);
    expect(windowsOn(STANDARD_HOURS, "2026-10-31", TZ)).toHaveLength(2); // Saturday 9–13
    expect(windowsOn(STANDARD_HOURS, "2026-11-01", TZ)).toHaveLength(0); // Sunday
    expect(windowsOn(STANDARD_HOURS, "2026-11-02", TZ)[0].start.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("labels slots in Austin time", () => {
    const [w] = windowsOn(STANDARD_HOURS, "2026-11-02", TZ);
    expect(slotLabel(w.start, w.end, TZ)).toBe("Mon, Nov 2, 08:00–10:00 CT");
  });

  const maya = { id: "maya", name: "Maya Torres", skills: ["plumbing"], workingHours: STANDARD_HOURS, active: true };
  const luis = { id: "luis", name: "Luis Ramirez", skills: ["electrical"], workingHours: STANDARD_HOURS, active: true };
  const base = {
    category: "plumbing",
    technicians: [maya, luis],
    busy: [],
    timeZone: TZ,
    bookingWindowDays: 14,
  };

  it("finds the next free slots across the weekend and the DST change", () => {
    const slots = findSlots({
      ...base,
      now: new Date("2026-10-31T17:30:00Z"), // Sat 12:30 CDT: today's last window has started
      preferredDate: "2026-10-31",
    });
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-11-02T14:00:00.000Z",
      "2026-11-02T16:00:00.000Z",
      "2026-11-02T18:00:00.000Z",
    ]);
    expect(slots[0]).toMatchObject({ technicianId: "maya", technicianFirstName: "Maya" });
  });

  it("skips busy slots, respects lead time, time of day and the booking window", () => {
    const now = new Date("2026-10-26T12:30:00Z"); // Mon 07:30 CDT: the 08:00 window is inside the lead time
    expect(findSlots({ ...base, now, preferredDate: "2026-10-26" })[0].start.toISOString()).toBe(
      "2026-10-26T15:00:00.000Z",
    );
    const busy = [{ technicianId: "maya", slotStart: new Date("2026-10-26T15:00:00Z") }];
    expect(findSlots({ ...base, now, busy, preferredDate: "2026-10-26" }).map((s) => s.start.toISOString())).toEqual([
      "2026-10-26T17:00:00.000Z",
      "2026-10-26T19:00:00.000Z",
      "2026-10-26T21:00:00.000Z",
    ]);
    const morning = findSlots({ ...base, now, preferredDate: "2026-10-26", timeOfDay: "morning" });
    expect(morning.map((s) => s.label)).toEqual([
      "Mon, Oct 26, 10:00–12:00 CT",
      "Tue, Oct 27, 08:00–10:00 CT",
      "Tue, Oct 27, 10:00–12:00 CT",
    ]);
    const afternoon = findSlots({ ...base, now, preferredDate: "2026-10-26", timeOfDay: "afternoon" });
    expect(afternoon.map((s) => s.label)).toEqual([
      "Mon, Oct 26, 12:00–14:00 CT",
      "Mon, Oct 26, 14:00–16:00 CT",
      "Mon, Oct 26, 16:00–18:00 CT",
    ]);
    expect(findSlots({ ...base, now, preferredDate: "2026-11-20" })).toEqual([]);
    expect(findSlots({ ...base, category: "roofing", now, preferredDate: "2026-10-26" })).toEqual([]);
  });

  it("offers a second technician when the first is busy, and each start only once", () => {
    const now = new Date("2026-10-26T12:30:00Z");
    const ana = { ...maya, id: "ana", name: "Ana Diaz" };
    const busy = [{ technicianId: "maya", slotStart: new Date("2026-10-26T15:00:00Z") }];
    const slots = findSlots({ ...base, technicians: [maya, ana, luis], busy, now, preferredDate: "2026-10-26" });
    expect(slots.map((s) => [s.start.toISOString(), s.technicianId])).toEqual([
      ["2026-10-26T15:00:00.000Z", "ana"],
      ["2026-10-26T17:00:00.000Z", "maya"],
      ["2026-10-26T19:00:00.000Z", "maya"],
    ]);
  });
});

describe("tokens (SPEC §20)", () => {
  const now = new Date("2026-10-22T12:00:00Z");

  it("round-trips and rejects tampering and expiry", () => {
    const token = sign("claim", { bookingId: "b1" }, 600, { now, env: ENV });
    expect(verify("claim", token, { now, env: ENV })).toEqual({ bookingId: "b1" });
    const [v, body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ bookingId: "b2", typ: "claim", exp: 9e9 })).toString("base64url");
    expect(verify("claim", `${v}.${forged}.${mac}`, { now, env: ENV })).toBeNull();
    expect(verify("claim", `${v}.${body}.${mac.slice(0, -2)}xx`, { now, env: ENV })).toBeNull();
    expect(verify("claim", token, { now: new Date(now.getTime() + 601_000), env: ENV })).toBeNull();
    expect(verify("claim", token, { now, env: { SESSION_SECRET: "t".repeat(48) } })).toBeNull();
    expect(verify("claim", "garbage", { now, env: ENV })).toBeNull();
  });

  it("rejects a token of one purpose wherever another is expected", () => {
    for (const minted of TOKEN_PURPOSES) {
      const token = sign(minted, { x: 1 }, 60, { now, env: ENV });
      for (const expected of TOKEN_PURPOSES) {
        expect(verify(expected, token, { now, env: ENV }) !== null).toBe(minted === expected);
      }
    }
  });

  it("caps lifetimes and refuses reserved claims", () => {
    expect(() => sign("slot", {}, 31 * 60, { now, env: ENV })).toThrow();
    expect(() => sign("claim", { typ: "slot" }, 60, { now, env: ENV })).toThrow();
    expect(() => sign("claim", {}, 60, { now, env: {} })).toThrow();
  });

  it("binds slot IDs to workspace and service", () => {
    const env = ENV;
    const prev = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = env.SESSION_SECRET;
    try {
      const start = new Date("2026-10-26T15:00:00Z");
      const id = slotId({ technicianId: "maya", start }, { workspaceId: "w1", serviceId: "s1" }, now);
      expect(readSlotId(id, { workspaceId: "w1", serviceId: "s1" }, now)).toEqual({ technicianId: "maya", start });
      expect(readSlotId(id, { workspaceId: "w2", serviceId: "s1" }, now)).toBeNull();
      expect(readSlotId(id, { workspaceId: "w1", serviceId: "s2" }, now)).toBeNull();
      expect(readSlotId(id, { workspaceId: "w1", serviceId: "s1" }, new Date(now.getTime() + 31 * 60_000))).toBeNull();
    } finally {
      process.env.SESSION_SECRET = prev;
    }
  });
});

describe("booking refs", () => {
  it("are HL- plus 5 Crockford characters", () => {
    for (let i = 0; i < 200; i += 1) expect(newBookingRef()).toMatch(BOOKING_REF);
  });
});
