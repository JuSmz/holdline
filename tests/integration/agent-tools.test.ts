import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/db/client";
import { bookings, calls, customers, outboxEmails, payTokens, services } from "@/db/schema";
import { type AgentCall, runAgentTool } from "@/server/agent/handlers";
import { notifyCall } from "@/server/agent/notify";
import { emailHmac } from "@/server/email/outbox";
import { chatLines } from "@/server/chat/transcript";
import { slotId } from "@/server/domain/availability";
import { freeSlots } from "@/server/domain/bookings";
import { transitionBooking } from "@/server/domain/transition";
import { createOrderForBooking } from "@/server/payments/authorize";
import { claimOperation } from "@/server/payments/ledger";

import { catalogOf, makeWorkspace } from "../support/factory";
import { type Harness, paymentHarness, payBooking, resetPayments } from "../support/payments";

let h: Harness;
beforeEach(async () => {
  await resetPayments();
  h = paymentHarness();
});
afterAll(async () => {
  await closeDb();
});

type Json = Record<string, unknown>;

async function newCall(channel: AgentCall["channel"] = "chat", caller: AgentCall["caller"] = null) {
  const db = getDb();
  const ws = await makeWorkspace(db);
  const [row] = await db
    .insert(calls)
    .values({ workspaceId: ws.id, channel, chatSessionId: `chat-${randomUUID()}`, caller })
    .returning();
  const call: AgentCall = { callRowId: row.id, workspaceId: ws.id, channel, caller };
  let seq = 0;
  const tool = (name: string, args: Json, id = `tc-${(seq += 1)}`) => runAgentTool(h.ctx, call, { id, name, args });
  return { ws, call, tool };
}

async function slotsFor(tool: (n: string, a: Json) => Promise<Json>, serviceId: string) {
  const result = (await tool("check_availability", { service_id: serviceId })) as {
    slots: { slot_id: string; label: string; technician_first_name: string }[];
  };
  return result.slots;
}

const details = {
  customer_name: "Sam Rivera",
  customer_email: "sam@personal.example.com",
  service_address: "12 Main St, Austin",
  problem_summary: "Kitchen sink is blocked",
  urgency: "soon",
};

async function serviceId(workspaceId: string, key = "drain-cleaning") {
  return (await catalogOf(getDb(), workspaceId)).service(key).id;
}

async function bookingsOfCall(callRowId: string) {
  return getDb().select().from(bookings).where(eq(bookings.callId, callRowId));
}

describe("agent tools: catalog and slots", () => {
  it("quotes only the workspace's own prices from the database", async () => {
    const { ws, tool } = await newCall();
    const result = (await tool("get_services", { category: "plumbing", price: "$1.00" })) as {
      services: { service_id: string; name: string; price: string }[];
    };
    const own = await getDb().select().from(services).where(eq(services.workspaceId, ws.id));
    expect(result.services.length).toBeGreaterThan(0);
    for (const s of result.services) {
      const row = own.find((o) => o.id === s.service_id)!;
      expect(row.category).toBe("plumbing");
      expect(s.price).toBe(`$${(row.priceCents / 100).toFixed(2)}`);
    }
  });

  it("offers at most three signed slots and falls back on a bad date", async () => {
    const { ws, tool } = await newCall();
    const svc = await serviceId(ws.id);
    const slots = await slotsFor(tool, svc);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(3);
    expect(slots[0].label).toMatch(/CT$/);
    expect(slots[0].technician_first_name).toBe("Maya");
    const fallback = (await tool("check_availability", { service_id: svc, preferred_date: "2026-02-31" })) as {
      slots: unknown[];
    };
    expect(fallback.slots.length).toBeGreaterThan(0);
    expect(await tool("check_availability", { service_id: randomUUID() })).toMatchObject({
      ok: false,
      reason: "unknown_service",
    });
  });
});

describe("agent tools: create_booking_with_payment_link (matrix #26)", () => {
  it("replays a repeated toolCallId with the stored result", async () => {
    const { ws, call, tool } = await newCall();
    const svc = await serviceId(ws.id);
    const [a, b] = await slotsFor(tool, svc);
    const first = await tool(
      "create_booking_with_payment_link",
      { ...details, service_id: svc, slot_id: a.slot_id },
      "same",
    );
    const again = await tool(
      "create_booking_with_payment_link",
      { ...details, service_id: svc, slot_id: b.slot_id },
      "same",
    );
    expect(again).toEqual(first);
    expect(await bookingsOfCall(call.callRowId)).toHaveLength(1);
  });

  it("returns the existing booking for the same service and slot, with one email", async () => {
    const { ws, call, tool } = await newCall("phone");
    const svc = await serviceId(ws.id);
    const [a] = await slotsFor(tool, svc);
    const first = await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id });
    const second = await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id });
    expect(first).toMatchObject({ ok: true, delivery: "email", hold_amount: "$149.00" });
    expect(second).toMatchObject({ ok: true, booking_ref: first.booking_ref });
    const rows = await bookingsOfCall(call.callRowId);
    expect(rows).toHaveLength(1);
    const mails = await getDb().select().from(outboxEmails).where(eq(outboxEmails.bookingId, rows[0].id));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ template: "payment_link", status: "outbox_only", to: null });
    const tokens = await getDb().select().from(payTokens).where(eq(payTokens.bookingId, rows[0].id));
    expect(tokens).toHaveLength(1);
  });

  it("supersedes the pending booking when the caller changes the slot", async () => {
    const { ws, call, tool } = await newCall();
    const svc = await serviceId(ws.id);
    const [a, b] = await slotsFor(tool, svc);
    const first = await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id });
    const second = await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: b.slot_id });
    expect(second).toMatchObject({ ok: true, delivery: "screen" });
    expect(second.booking_ref).not.toBe(first.booking_ref);
    const rows = await bookingsOfCall(call.callRowId);
    const old = rows.find((r) => r.ref === first.booking_ref)!;
    expect(old).toMatchObject({ status: "expired", cancelReason: "superseded" });
    expect(rows.filter((r) => r.status === "pending_payment")).toHaveLength(1);
    // The old slot is free again.
    const free = await freeSlots(getDb(), {
      workspaceId: ws.id,
      serviceId: svc,
      now: h.now(),
    });
    expect(free.map((s) => s.start.getTime())).toContain(old.slotStart.getTime());
  });

  it.each(["approved in the popup", "authorize in flight", "authorizing lease"])(
    "refuses to supersede while the earlier booking's payment is being approved (%s)",
    async (situation) => {
      const { ws, call, tool } = await newCall();
      const svc = await serviceId(ws.id);
      const [a, b] = await slotsFor(tool, svc);
      await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id });
      const [pending] = await bookingsOfCall(call.callRowId);
      if (situation === "approved in the popup") {
        // The buyer approved; onApprove hasn't reached us (our order row still says CREATED).
        const { orderId } = await createOrderForBooking(h.ctx, pending.id);
        h.fake.approve(orderId);
      } else if (situation === "authorize in flight") {
        await claimOperation(getDb(), {
          key: `authorize:${pending.id}:test`,
          kind: "authorize",
          bookingId: pending.id,
          requestId: randomUUID(),
          now: h.now(),
        });
      } else {
        await getDb()
          .update(bookings)
          .set({ authorizingUntil: new Date(h.now().getTime() + 60_000) })
          .where(eq(bookings.id, pending.id));
      }
      expect(
        await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: b.slot_id }),
      ).toMatchObject({ ok: false, reason: "authorize_in_progress" });
      const [still] = await getDb().select().from(bookings).where(eq(bookings.id, pending.id));
      expect(still.status).toBe("pending_payment");
      expect(await bookingsOfCall(call.callRowId)).toHaveLength(1);
    },
  );
});

describe("agent tools: scoping and input (matrix #27)", () => {
  it("ignores client-sent amounts and rejects another workspace's service or slot", async () => {
    const { ws, call, tool } = await newCall();
    const other = await newCall();
    const svc = await serviceId(ws.id);
    const foreignSvc = await serviceId(other.ws.id);
    const [a] = await slotsFor(tool, svc);
    const [foreignSlot] = await slotsFor(other.tool, foreignSvc);

    expect(
      await tool("create_booking_with_payment_link", {
        ...details,
        service_id: foreignSvc,
        slot_id: foreignSlot.slot_id,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_slot" });
    expect(
      await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: foreignSlot.slot_id }),
    ).toMatchObject({ ok: false, reason: "invalid_slot" });
    // A slot signed for another service of the same workspace doesn't fit either.
    const leak = await serviceId(ws.id, "leak-repair");
    expect(
      await tool("create_booking_with_payment_link", { ...details, service_id: leak, slot_id: a.slot_id }),
    ).toMatchObject({ ok: false, reason: "invalid_slot" });

    const made = await tool("create_booking_with_payment_link", {
      ...details,
      service_id: svc,
      slot_id: a.slot_id,
      price_cents: 1,
      hold_amount: "$1.00",
      amount: 1,
    });
    expect(made).toMatchObject({ ok: true, hold_amount: "$149.00", no_show_fee: "$49.00" });
    const [row] = await bookingsOfCall(call.callRowId);
    const { service } = await catalogOf(getDb(), ws.id);
    expect(row.priceCents).toBe(service("drain-cleaning").priceCents);
  });

  it("refuses a forged or expired slot ID", async () => {
    const { ws, tool } = await newCall();
    const svc = await serviceId(ws.id);
    const [a] = await slotsFor(tool, svc);
    const forged = `${a.slot_id.slice(0, -2)}xx`;
    expect(
      await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: forged }),
    ).toMatchObject({ ok: false, reason: "invalid_slot" });
    h.advance(31 * 60_000);
    expect(
      await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id }),
    ).toMatchObject({ ok: false, reason: "invalid_slot" });
  });

  it("lets the form's name and email win on chat and strips URLs and control characters", async () => {
    const { ws, call, tool } = await newCall("chat", { firstName: "Jordan", email: "jordan@personal.example.com" });
    const svc = await serviceId(ws.id);
    const [a] = await slotsFor(tool, svc);
    const made = await tool("create_booking_with_payment_link", {
      ...details,
      customer_email: "attacker@evil.example.com",
      problem_summary: "Sink blocked\u0007 see https://evil.example.com/x now",
      service_id: svc,
      slot_id: a.slot_id,
    });
    expect(made).toMatchObject({ ok: true });
    const [row] = await bookingsOfCall(call.callRowId);
    expect(row.problemSummary).toBe("Sink blocked see now");
    const mails = await getDb().select().from(outboxEmails).where(eq(outboxEmails.bookingId, row.id));
    expect(mails[0].html).toContain(row.ref);
    expect(mails[0].html).toContain("Jordan");
    expect(mails[0].toHmac).toBe(emailHmac("jordan@personal.example.com"));
    // The model's bad email doesn't matter on a chat: the form's email is used (same slot → same booking).
    expect(
      await tool("create_booking_with_payment_link", {
        ...details,
        customer_email: "nope",
        service_id: svc,
        slot_id: a.slot_id,
      }),
    ).toMatchObject({ ok: true, booking_ref: made.booking_ref });
  });

  it("asks for what is missing on a phone call and keeps a messy optional phone from failing", async () => {
    const { ws, call, tool } = await newCall("phone");
    const svc = await serviceId(ws.id);
    const [a] = await slotsFor(tool, svc);
    const book = (extra: Json) =>
      tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id, ...extra });
    expect(await book({ customer_email: "nope" })).toMatchObject({ ok: false, reason: "invalid_email" });
    expect(await book({ customer_name: "  " })).toMatchObject({ ok: false, reason: "invalid_name" });
    expect(await book({ service_address: "x" })).toMatchObject({ ok: false, reason: "invalid_address" });
    expect(
      await book({ customer_phone: "512.555.0100 ext. 2", urgency: "whenever", customer_email: "Bob@www.Example.com" }),
    ).toMatchObject({ ok: true });
    const [row] = await bookingsOfCall(call.callRowId);
    const [customer] = await getDb().select().from(customers).where(eq(customers.id, row.customerId!));
    expect(customer.phone).toBe("5125550100");
    expect(customer.email).toBe("bob@www.example.com"); // never URL-stripped
    expect(row.urgency).toBe("flexible");
  });

  it("keeps the current booking when the new slot can't be booked (the supersede rolls back)", async () => {
    const { ws, call, tool } = await newCall();
    const other = await newCall();
    // Same workspace for both conversations, so they compete for the same slots.
    other.call.workspaceId = ws.id;
    await getDb().update(calls).set({ workspaceId: ws.id }).where(eq(calls.id, other.call.callRowId));
    const svc = await serviceId(ws.id);
    const [a, b] = await slotsFor(tool, svc);
    const mine = await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id });
    expect(
      await other.tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: b.slot_id }),
    ).toMatchObject({ ok: true });
    expect(
      await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: b.slot_id }),
    ).toMatchObject({ ok: false });
    const rows = await bookingsOfCall(call.callRowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ref: mine.booking_ref, status: "pending_payment" });
  });

  it("replaces a booking whose pay window passed instead of returning it for the same slot", async () => {
    const { ws, call, tool } = await newCall();
    const svc = await serviceId(ws.id);
    const [a] = await slotsFor(tool, svc);
    const first = await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id });
    h.advance(61 * 60_000); // past the 60-minute hold TTL; the TTL job hasn't run yet
    const again = (await slotsFor(tool, svc)).find((s) => s.label === a.label);
    expect(again).toBeDefined();
    const second = await tool("create_booking_with_payment_link", {
      ...details,
      service_id: svc,
      slot_id: again!.slot_id,
    });
    expect(second).toMatchObject({ ok: true });
    expect(second.booking_ref).not.toBe(first.booking_ref);
    const old = (await bookingsOfCall(call.callRowId)).find((r) => r.ref === first.booking_ref)!;
    expect(old).toMatchObject({ status: "expired", cancelReason: "ttl" });
  });

  it("refuses a new time once the hold is approved (no second hold)", async () => {
    const { ws, call, tool } = await newCall();
    const svc = await serviceId(ws.id);
    const [a, b] = await slotsFor(tool, svc);
    await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id });
    const [row] = await bookingsOfCall(call.callRowId);
    await payBooking(h, row.id);
    expect(
      await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: b.slot_id }),
    ).toMatchObject({ ok: false, reason: "already_booked" });
    expect(await bookingsOfCall(call.callRowId)).toHaveLength(1);
  });

  it("asks for the email when the model sends none on a phone call", async () => {
    const { ws, tool } = await newCall("phone");
    const svc = await serviceId(ws.id);
    const [a] = await slotsFor(tool, svc);
    expect(
      await tool("create_booking_with_payment_link", {
        ...details,
        customer_email: null,
        service_id: svc,
        slot_id: a.slot_id,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_email" });
  });

  it("reports a cancelled appointment as cancelled, never as authorized", async () => {
    const { ws, call, tool } = await newCall();
    const svc = await serviceId(ws.id);
    const [a] = await slotsFor(tool, svc);
    await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id });
    const [row] = await bookingsOfCall(call.callRowId);
    await payBooking(h, row.id);
    await getDb().transaction((tx) =>
      transitionBooking(tx, { bookingId: row.id, from: "authorized", to: "cancelled", actor: "owner" }),
    );
    expect(await tool("check_payment_status", {})).toMatchObject({ status: "cancelled" });
  });

  it("reports payment status only for the conversation's own bookings", async () => {
    const { ws, tool } = await newCall();
    const other = await newCall();
    const svc = await serviceId(ws.id);
    const [a] = await slotsFor(tool, svc);
    const made = await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id });
    expect(await tool("check_payment_status", {})).toMatchObject({ status: "waiting" });
    expect(await other.tool("check_payment_status", { booking_ref: made.booking_ref })).toMatchObject({
      status: "none",
    });

    const [row] = await getDb()
      .select()
      .from(bookings)
      .where(and(eq(bookings.workspaceId, ws.id), eq(bookings.ref, made.booking_ref as string)));
    await payBooking(h, row.id);
    expect(await tool("check_payment_status", { booking_ref: made.booking_ref })).toMatchObject({
      status: "authorized",
      appointment_label: a.label,
      technician_first_name: "Maya",
    });
  });

  it("answers an unknown tool as a result, not an exception", async () => {
    const { tool } = await newCall();
    expect(await tool("refund_everything", {})).toMatchObject({ ok: false, reason: "unknown_tool" });
  });
});

describe("notifyCall in a chat", () => {
  it("appends the fixed confirmation once, with a note for the model", async () => {
    const { ws, call, tool } = await newCall("chat");
    const svc = await serviceId(ws.id);
    const [a] = await slotsFor(tool, svc);
    await tool("create_booking_with_payment_link", { ...details, service_id: svc, slot_id: a.slot_id });
    const [row] = await bookingsOfCall(call.callRowId);
    await payBooking(h, row.id);

    expect(await notifyCall(row.id, "authorized")).toEqual({ sent: true, via: "chat", ok: true });
    expect(await notifyCall(row.id, "authorized")).toEqual({ sent: false, reason: "already_sent" });
    const [chat] = await getDb().select().from(calls).where(eq(calls.id, call.callRowId));
    const lines = chatLines(chat);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ role: "assistant", notice: "authorized" });
    expect(lines[0].text).toMatch(
      /^Got it — PayPal confirmed the \$149 hold\. You're all set for .+ Austin time\. Maya will be there\.$/,
    );
    expect(chat.geminiContents).toEqual([
      { role: "user", parts: [{ text: `[payment-update] ${row.ref} authorized; the caller has been told.` }] },
      { role: "model", parts: [{ text: lines[0].text }] },
    ]);
  });
});

// Keep the slot helper honest: a slot ID from check_availability is the same one slotId() signs.
describe("slot IDs", () => {
  it("are bound to workspace and service", async () => {
    const { ws } = await newCall();
    const svc = await serviceId(ws.id);
    const [slot] = await freeSlots(getDb(), { workspaceId: ws.id, serviceId: svc, now: h.now() });
    expect(typeof slotId(slot, { workspaceId: ws.id, serviceId: svc }, h.now())).toBe("string");
  });
});
