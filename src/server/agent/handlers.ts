import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { agentToolCalls, bookings, calls, paypalOrders, services, technicians, workspaces } from "@/db/schema";
import type { Executor } from "@/db/types";
import { appUrl } from "@/server/config/env";
import { dbErrorCode } from "@/server/db-error";
import { readSlotId, slotId } from "@/server/domain/availability";
import { BookingInputError, createPendingBooking, freeSlots } from "@/server/domain/bookings";
import { policyOf } from "@/server/domain/policy";
import { addDays, DATE_PATTERN, localDate, slotLabel } from "@/server/domain/time";
import { type Booking, lockBooking, transitionBooking } from "@/server/domain/transition";
import { queueEmail } from "@/server/email/outbox";
import { cleanFirstName, paymentLinkEmail } from "@/server/email/templates";
import { formatUsd } from "@/server/money";
import { defaultContext, type PaymentContext } from "@/server/payments/context";
import { hasOperationInFlight } from "@/server/payments/ledger";
import { issuePayToken } from "@/server/payments/pay-tokens";
import { getOrder } from "@/server/paypal/orders";

import type { Channel } from "./prompt";
import type { ToolName } from "./tools";

/** The conversation a tool call belongs to: resolved only from our own binding, never from arguments (§13.3). */
export type AgentCall = {
  callRowId: string;
  workspaceId: string;
  channel: Channel;
  caller: { firstName?: string; email?: string } | null;
};

/** Tool handlers run with the payment context: a supersede may have to ask PayPal about an open order. */
export type AgentContext = PaymentContext;

export const agentContext = defaultContext;

export function agentCallOf(row: typeof calls.$inferSelect): AgentCall {
  return { callRowId: row.id, workspaceId: row.workspaceId, channel: row.channel, caller: row.caller ?? null };
}

type Json = Record<string, unknown>;

/**
 * Runs one tool call (SPEC §13.3). Business outcomes are results; only real failures throw.
 * A replayed toolCallId returns the stored result.
 */
export async function runAgentTool(
  ctx: AgentContext,
  call: AgentCall,
  tool: { id: string; name: string; args: Json | null },
): Promise<Json> {
  const [replayed] = await ctx.db
    .select()
    .from(agentToolCalls)
    .where(and(eq(agentToolCalls.callId, call.callRowId), eq(agentToolCalls.toolCallId, tool.id.slice(0, 200))));
  if (replayed) return replayed.result as Json;

  const args = tool.args ?? {};
  let result: Json;
  switch (tool.name as ToolName) {
    case "get_services":
      result = await getServices(ctx, call, args);
      break;
    case "check_availability":
      result = await checkAvailability(ctx, call, args);
      break;
    case "create_booking_with_payment_link":
      result = await createBookingTool(ctx, call, args);
      break;
    case "check_payment_status":
      result = await checkPaymentStatus(ctx, call, args);
      break;
    default:
      return { ok: false, reason: "unknown_tool" };
  }
  try {
    await ctx.db
      .insert(agentToolCalls)
      .values({ callId: call.callRowId, toolCallId: tool.id.slice(0, 200), name: tool.name.slice(0, 80), result })
      .onConflictDoNothing();
  } catch (error) {
    // The replay record is best effort: the tool's own work is already committed, so its result must
    // still reach the conversation (a repeat of this toolCallId then simply runs again, idempotently).
    console.error(`[holdline] could not store the ${tool.name} result for replay: ${dbErrorCode(error)}`);
  }
  return result;
}

// ── Input hygiene (SPEC §13.3) ────────────────────────────────────────────────────────────────────

const URLS = /https?:\/\/\S+|www\.\S+/gi;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const tidy = (s: string, max: number) =>
  s.toWellFormed().replace(URLS, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);
const clean = (max: number) => z.string().transform((s) => tidy(s, max));
/** Optional text the form may override: anything that isn't a string is simply absent, never a refusal. */
const optionalText = (max: number) =>
  z
    .unknown()
    .transform((v) => (typeof v === "string" ? tidy(v, max) || undefined : undefined))
    .optional();

/** An optional phone: digits and a leading + only; anything unusable is dropped, never a refusal. */
const phone = z
  .unknown()
  .transform((value) => {
    if (typeof value !== "string") return undefined;
    const digits = value
      .replace(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i, "")
      .trim()
      .replace(/(?!^\+)[^0-9]/g, "");
    return /^\+?[0-9]{7,15}$/.test(digits) ? digits : undefined;
  })
  .optional();

const bookingArgs = z.object({
  service_id: z.string().max(64),
  slot_id: z.string().max(2048),
  customer_name: optionalText(80),
  // An address is never URL-stripped ("bob@www.example.com" is valid); emailSchema checks it below.
  customer_email: z
    .unknown()
    .transform((v) => (typeof v === "string" ? v.toWellFormed().replace(CONTROL, "").trim() || undefined : undefined))
    .optional(),
  customer_phone: phone,
  service_address: clean(200).pipe(z.string().min(3)),
  problem_summary: clean(500).pipe(z.string().min(1)),
  urgency: z.enum(["emergency", "soon", "flexible"]).catch("flexible"),
});

const emailSchema = z.email().max(120);

// ── get_services ─────────────────────────────────────────────────────────────────────────────────

async function getServices(ctx: AgentContext, call: AgentCall, args: Json): Promise<Json> {
  const category = args.category === "plumbing" || args.category === "electrical" ? args.category : undefined;
  const rows = await ctx.db
    .select()
    .from(services)
    .where(and(eq(services.workspaceId, call.workspaceId), eq(services.active, true)))
    .orderBy(services.sortOrder);
  const list = rows
    .filter((s) => !category || s.category === category)
    .sort((a, b) => (args.urgent === true ? Number(b.isEmergency) - Number(a.isEmergency) : 0));
  return {
    services: list.map((s) => ({
      service_id: s.id,
      name: s.name,
      description: s.description,
      price: formatUsd(s.priceCents),
      duration_min: s.durationMin,
      no_show_fee: formatUsd(s.noShowFeeCents),
      emergency: s.isEmergency,
    })),
  };
}

// ── check_availability ───────────────────────────────────────────────────────────────────────────

async function workspaceService(ctx: AgentContext, call: AgentCall, serviceId: unknown) {
  if (typeof serviceId !== "string" || !/^[0-9a-f-]{36}$/.test(serviceId)) return null;
  const [row] = await ctx.db
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.workspaceId, call.workspaceId), eq(services.active, true)));
  return row ?? null;
}

async function checkAvailability(ctx: AgentContext, call: AgentCall, args: Json): Promise<Json> {
  const service = await workspaceService(ctx, call, args.service_id);
  if (!service) return { ok: false, reason: "unknown_service", say: "Let me look up the service again." };
  const now = ctx.now();
  const [ws] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, call.workspaceId));
  const today = localDate(now, ws.timezone);
  const preferred =
    typeof args.preferred_date === "string" && DATE_PATTERN.test(args.preferred_date) && isRealDate(args.preferred_date)
      ? args.preferred_date
      : args.urgent === true
        ? today
        : addDays(today, 1);
  const timeOfDay = args.time_of_day === "morning" || args.time_of_day === "afternoon" ? args.time_of_day : "any";
  const slots = await freeSlots(ctx.db, {
    workspaceId: call.workspaceId,
    serviceId: service.id,
    preferredDate: preferred,
    timeOfDay,
    now,
  });
  return {
    slots: slots.map((s) => ({
      slot_id: slotId(s, { workspaceId: call.workspaceId, serviceId: service.id }, now),
      label: s.label,
      technician_first_name: s.technicianFirstName,
    })),
    ...(slots.length === 0 ? { note: "No free time in the next two weeks for that choice." } : {}),
  };
}

function isRealDate(date: string): boolean {
  const d = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

// ── create_booking_with_payment_link ─────────────────────────────────────────────────────────────

const CANCELLATION = (fee: string, hours: number) =>
  `Free cancellation up to ${hours} hours before the visit; after that the ${fee} no-show fee applies.`;

/** A refusal inside the booking transaction: thrown so the supersede rolls back with it. */
class BookingRefusal extends Error {
  constructor(
    readonly reason: string,
    readonly say: string,
  ) {
    super(reason);
    this.name = "BookingRefusal";
  }
}

const AUTHORIZING_SAY = "The payment for the earlier time is being approved right now, so let's keep that one.";

/** Still payable: inside its pay window, or an authorize is running (the TTL job may not have run yet). */
const isPayable = (b: Booking, now: Date) =>
  b.holdExpiresAt > now || (b.authorizingUntil !== null && b.authorizingUntil > now);

async function createBookingTool(ctx: AgentContext, call: AgentCall, raw: Json): Promise<Json> {
  const parsed = bookingArgs.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return field === "service_address"
      ? { ok: false, reason: "invalid_address", say: "Could you tell me the full service address?" }
      : field === "problem_summary"
        ? { ok: false, reason: "invalid_summary", say: "Could you describe the problem in a few words?" }
        : { ok: false, reason: "invalid_slot", say: "Let me check the schedule again." };
  }
  const args = parsed.data;
  // On web calls and chats the form's name and email win over anything the model heard (§13.3).
  const form = call.channel !== "phone" ? call.caller : null;
  const name = (form?.firstName ?? args.customer_name ?? "").trim();
  const email = emailSchema.safeParse((form?.email ?? args.customer_email ?? "").toLowerCase());
  if (!name) return { ok: false, reason: "invalid_name", say: "Could I get your name for the booking?" };
  if (!email.success) {
    return { ok: false, reason: "invalid_email", say: "I need a valid email address for the PayPal link." };
  }

  const service = await workspaceService(ctx, call, args.service_id);
  const slot = service
    ? readSlotId(args.slot_id, { workspaceId: call.workspaceId, serviceId: service.id }, ctx.now())
    : null;
  if (!service || !slot) {
    return {
      ok: false,
      reason: "invalid_slot",
      say: "That time is no longer available — let me check the schedule again.",
    };
  }

  const now = ctx.now();
  // The customer may have approved the earlier booking's order in the popup a moment ago, before
  // onApprove reached us: ask PayPal first, like the TTL expiry does (SPEC §9.2). A buyer who approves
  // between this GET and the transaction below loses that approval (onApprove then finds the booking
  // superseded and nothing is charged); the window is one round trip and is accepted.
  const earlier = await earlierOrderApproved(ctx, call, service.id, slot.start, now).catch(() => "unknown" as const);
  if (earlier === "unknown") {
    return { ok: false, reason: "payment_check_failed", say: "Let me try that change again in a moment." };
  }
  if (earlier) return { ok: false, reason: "authorize_in_progress", say: AUTHORIZING_SAY };

  let result: { booking: Booking; label: string; policy: string };
  try {
    result = await ctx.db.transaction(async (tx) => {
      // One booking per call: serialize this call's tool calls on its row.
      await tx.select({ id: calls.id }).from(calls).where(eq(calls.id, call.callRowId)).for("update");
      // The reset fence (src/server/workspaces/fence.ts): read after the row lock, which the reset purge
      // also takes, so a copy reset meanwhile gets no new customer, booking or email.
      const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, call.workspaceId));
      if (ws.resetAt) throw new BookingRefusal("demo_reset", "This demo was reset, so I can't book anything here.");
      const describe = (b: Booking) => ({
        label: slotLabel(b.slotStart, b.slotEnd, ws.timezone),
        policy: CANCELLATION(formatUsd(b.noShowFeeCents), policyOf(ws.policy).cancellationWindowHours),
      });
      // An approved hold is never replaced here (that would leave the customer with two holds).
      const [confirmed] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(eq(bookings.callId, call.callRowId), eq(bookings.status, "authorized")))
        .limit(1);
      if (confirmed) {
        throw new BookingRefusal(
          "already_booked",
          "Your appointment is already confirmed; the business can reschedule it for you.",
        );
      }
      const current = await pendingOfCall(tx, call.callRowId);
      const payable = current !== null && isPayable(current, now);
      if (
        current &&
        payable &&
        current.serviceId === service.id &&
        current.slotStart.getTime() === slot.start.getTime()
      ) {
        return { booking: current, ...describe(current) };
      }
      if (current) {
        // A different service or slot supersedes; a booking past its pay window is expired (ttl).
        const locked = await lockBooking(tx, current.id);
        const [order] = await tx
          .select({ status: paypalOrders.status })
          .from(paypalOrders)
          .where(eq(paypalOrders.bookingId, current.id))
          .orderBy(desc(paypalOrders.attempt))
          .limit(1);
        const authorizing =
          (locked.authorizingUntil && locked.authorizingUntil > now) ||
          order?.status === "APPROVED" ||
          order?.status === "COMPLETED" ||
          (await hasOperationInFlight(tx, current.id, "authorize:"));
        if (authorizing) throw new BookingRefusal("authorize_in_progress", AUTHORIZING_SAY);
        const reason = payable ? "superseded" : "ttl";
        await transitionBooking(tx, {
          bookingId: current.id,
          from: "pending_payment",
          to: "expired",
          actor: "agent",
          reason,
          patch: { cancelReason: reason },
        });
      }
      let booking: Booking;
      try {
        booking = await createPendingBooking(tx, {
          workspaceId: call.workspaceId,
          serviceId: service.id,
          technicianId: slot.technicianId,
          slotStart: slot.start,
          customer: { name, email: email.data, phone: args.customer_phone ?? null, address: args.service_address },
          problemSummary: args.problem_summary,
          urgency: args.urgency,
          callId: call.callRowId,
          now,
        });
      } catch (error) {
        // Thrown, not returned: the supersede above must roll back with it (the caller keeps their slot).
        if (error instanceof BookingInputError) {
          throw new BookingRefusal(
            error.code === "slot_taken" ? "slot_taken" : "invalid_slot",
            "Someone just took that time — let me find you another one.",
          );
        }
        throw error;
      }
      // The payment-link email with its own single-purpose pay link, in the same transaction, so a
      // booking never exists without them (SPEC §19, §20).
      const described = describe(booking);
      const token = await issuePayToken(tx, {
        bookingId: booking.id,
        purpose: "email_link",
        expiresAt: booking.slotStart,
      });
      await queueEmail(tx, {
        workspaceId: call.workspaceId,
        bookingId: booking.id,
        idempotencyKey: `payment_link:${booking.id}`,
        to: email.data,
        email: paymentLinkEmail({
          businessName: ws.name,
          ref: booking.ref,
          serviceName: booking.serviceName,
          slotLabel: described.label,
          firstName: cleanFirstName(name),
          holdAmount: formatUsd(booking.priceCents),
          noShowFee: formatUsd(booking.noShowFeeCents),
          payUrl: `${appUrl()}/pay/${token}`,
        }),
      });
      return { booking, ...described };
    });
  } catch (error) {
    if (error instanceof BookingRefusal) return { ok: false, reason: error.reason, say: error.say };
    throw error;
  }

  const { booking } = result;
  const delivery = call.channel === "phone" ? "email" : "screen";
  return {
    ok: true,
    booking_ref: booking.ref,
    appointment_label: result.label,
    hold_amount: formatUsd(booking.priceCents),
    no_show_fee: formatUsd(booking.noShowFeeCents),
    cancellation_policy: result.policy,
    delivery,
    next_step:
      delivery === "screen"
        ? "The PayPal button is on the customer's screen now. Explain that it is a hold, not a charge, then wait."
        : "The PayPal link is in the customer's email. Read out the booking reference and explain the hold.",
  };
}

/** True if this call's pending booking for another service or slot has an order PayPal reports APPROVED. */
async function earlierOrderApproved(ctx: AgentContext, call: AgentCall, serviceId: string, start: Date, now: Date) {
  const current = await pendingOfCall(ctx.db, call.callRowId);
  if (!current) return false;
  if (isPayable(current, now) && current.serviceId === serviceId && current.slotStart.getTime() === start.getTime()) {
    return false;
  }
  const [order] = await ctx.db
    .select()
    .from(paypalOrders)
    .where(eq(paypalOrders.bookingId, current.id))
    .orderBy(desc(paypalOrders.attempt))
    .limit(1);
  if (!order || !["CREATED", "PAYER_ACTION_REQUIRED"].includes(order.status)) return false;
  const remote = await getOrder(ctx.paypal, order.paypalOrderId);
  return remote.status === "APPROVED" || remote.status === "COMPLETED";
}

async function pendingOfCall(db: Executor, callRowId: string) {
  const [row] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.callId, callRowId), eq(bookings.status, "pending_payment")));
  return row ?? null;
}

// ── check_payment_status ─────────────────────────────────────────────────────────────────────────

/** What check_payment_status reports for each booking status (SPEC §13.2). */
const STATUS_REPORT: Record<Booking["status"], string> = {
  pending_payment: "waiting",
  authorized: "authorized",
  completed: "completed",
  captured: "completed",
  paid_out: "completed",
  no_show: "cancelled",
  cancelled: "cancelled",
  voided: "cancelled",
  expired: "expired",
};

async function checkPaymentStatus(ctx: AgentContext, call: AgentCall, args: Json): Promise<Json> {
  const rows = await ctx.db
    .select()
    .from(bookings)
    .where(eq(bookings.callId, call.callRowId))
    .orderBy(desc(bookings.createdAt));
  const ref = typeof args.booking_ref === "string" ? args.booking_ref.trim().toUpperCase() : null;
  // Only bookings of this conversation (§13.3); without a ref, the newest one that isn't expired.
  const booking = ref ? rows.find((r) => r.ref === ref) : (rows.find((r) => r.status !== "expired") ?? rows[0]);
  if (!booking) return { status: "none", note: "No booking in this conversation yet." };

  if (booking.status === "pending_payment") {
    if (booking.paymentIssue === "authorization_pending") return { status: "processing" };
    const [order] = await ctx.db
      .select({ status: paypalOrders.status })
      .from(paypalOrders)
      .where(eq(paypalOrders.bookingId, booking.id))
      .orderBy(desc(paypalOrders.attempt))
      .limit(1);
    return { status: order?.status === "DECLINED" || order?.status === "DENIED" ? "declined_retry" : "waiting" };
  }
  const status = STATUS_REPORT[booking.status];
  if (status === "cancelled") {
    return { status, note: "The business cancelled this appointment. Don't call it confirmed." };
  }
  if (status !== "authorized") return { status };
  const [ws] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, booking.workspaceId));
  const [tech] = await ctx.db.select().from(technicians).where(eq(technicians.id, booking.technicianId));
  return {
    status,
    appointment_label: slotLabel(booking.slotStart, booking.slotEnd, ws.timezone),
    technician_first_name: tech?.name.split(" ")[0] ?? "",
  };
}
