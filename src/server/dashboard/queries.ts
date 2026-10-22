import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import {
  addonItems,
  authorizations,
  bookingEvents,
  bookings,
  calls,
  captures,
  customers,
  invoices,
  outboxEmails,
  paymentOperations,
  paypalOrders,
  payouts,
  services,
  technicians,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { chatLines } from "@/server/chat/transcript";
import { isLateCancellation, policyOf } from "@/server/domain/policy";
import type { Workspace } from "@/server/workspaces/guard";

import { type ActionKey, availableActions, retryablePayouts } from "./actions";
import { appointmentLabel, durationLabel, firstName, momentLabel, usd } from "./format";
import {
  actorLabel,
  authorizationStatusLabel,
  CAPTURE_KIND,
  captureStatusLabel,
  eventLine,
  invoiceLine,
  invoiceStatusLabel,
  type LineKind,
  type LineTone,
  OUTBOX_STATUS,
  orderStatusLabel,
  payoutLine,
  payoutStatusLabel,
  payoutTone,
  summaryOutcomeLabel,
} from "./wording";

/**
 * Everything the owner dashboard shows (SPEC §18), scoped to one demo workspace. Payloads stay lean:
 * plain-English labels and formatted amounts, first names only, PayPal IDs only in the detail views,
 * never a token, a controlUrl or an address.
 */

const BOOKING_LIMIT = 60;
const CALL_LIMIT = 40;
const OUTBOX_LIMIT = 30;
const LEDGER_LIMIT = 60;

type BookingDb = typeof bookings.$inferSelect;
type CaptureDb = typeof captures.$inferSelect;
type InvoiceDb = typeof invoices.$inferSelect;
type PayoutDb = typeof payouts.$inferSelect & { technicianName: string };

export type Status = { label: string; tone: LineTone };

export type BookingRow = {
  id: string;
  ref: string;
  sample: boolean;
  status: string;
  flag: string | null;
  serviceName: string;
  day: string;
  time: string;
  slotStart: string;
  /** The visit is over. */
  past: boolean;
  /** The visit has started (server clock), so the dialogs needn't warn that it hasn't. */
  started: boolean;
  customer: string;
  technician: string;
  hold: string;
  noShowFee: string;
  /** What was taken from the hold, e.g. { amount: "$39.00", label: "no-show fee" }. */
  charged: { amount: string; label: string } | null;
  /** The extra-work badge (SPEC §9.6): "Extra work invoiced · $25.00". */
  extra: string | null;
  /** The amount a retry capture or a fallback invoice asks for. */
  due: string;
  /** The payout a retry sends again: the dialog names it, and the click sends its `id`. */
  failedPayout: { id: string; amount: string; technician: string } | null;
  actions: ActionKey[];
  /** A payment step is unresolved: the page disables the actions and says PayPal is working. */
  busy: boolean;
  /** The late-cancellation rule now, on the server clock (refreshed on every poll; the action re-checks it). */
  lateNow: boolean;
  /** For the dialog's wording ("less than 24 hours before the visit"). */
  cancelWindowHours: number;
};

export type LedgerEntry = {
  id: string;
  at: string;
  atLabel: string;
  bookingId: string;
  ref: string;
  sample: boolean;
  kind: LineKind;
  /** The activity line: "Technician payout sent · Maya · $89.40". */
  text: string;
  title: string;
  sub: string;
  amount: string;
  sign: "+" | "−" | "";
  status: Status;
  tone: LineTone;
};

type Facts = {
  captures: Map<string, CaptureDb[]>;
  invoices: Map<string, InvoiceDb[]>;
  payouts: Map<string, PayoutDb[]>;
  inFlight: Map<string, string[]>;
  jobDone: Set<string>;
};

const group = <T, K>(rows: T[], key: (r: T) => K) => {
  const map = new Map<K, T[]>();
  for (const r of rows) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
  return map;
};

/** Captures, invoices, payouts, unresolved ledger rows and "job done" marks for these bookings. */
async function loadFacts(db: Db, ids: string[]): Promise<Facts> {
  if (ids.length === 0) {
    return { captures: new Map(), invoices: new Map(), payouts: new Map(), inFlight: new Map(), jobDone: new Set() };
  }
  const [cap, inv, pay, ops, done] = await Promise.all([
    db.select().from(captures).where(inArray(captures.bookingId, ids)).orderBy(asc(captures.createdAt)),
    db.select().from(invoices).where(inArray(invoices.bookingId, ids)).orderBy(asc(invoices.createdAt)),
    db
      .select({ payout: payouts, technicianName: technicians.name })
      .from(payouts)
      .innerJoin(technicians, eq(technicians.id, payouts.technicianId))
      .where(inArray(payouts.bookingId, ids))
      // The same order the retry action uses (actions.ts retryableOf), so the dialog names that payout.
      .orderBy(asc(payouts.createdAt), asc(payouts.attemptNo), asc(payouts.id)),
    db
      .select({ bookingId: paymentOperations.bookingId, key: paymentOperations.key })
      .from(paymentOperations)
      .where(and(inArray(paymentOperations.bookingId, ids), eq(paymentOperations.state, "in_flight"))),
    db
      .selectDistinct({ bookingId: bookingEvents.bookingId })
      .from(bookingEvents)
      .where(and(inArray(bookingEvents.bookingId, ids), eq(bookingEvents.toStatus, "completed"))),
  ]);
  return {
    captures: group(cap, (c) => c.bookingId),
    invoices: group(inv, (i) => i.bookingId),
    payouts: group(
      pay.map((p) => ({ ...p.payout, technicianName: p.technicianName })),
      (p) => p.bookingId,
    ),
    inFlight: ops.reduce((map, o) => {
      if (o.bookingId) map.set(o.bookingId, [...(map.get(o.bookingId) ?? []), o.key]);
      return map;
    }, new Map<string, string[]>()),
    jobDone: new Set(done.map((d) => d.bookingId)),
  };
}

function bookingRow(
  b: BookingDb,
  names: { customer: string | null; technician: string },
  facts: Facts,
  ws: Workspace,
  now: Date,
): BookingRow {
  const policy = policyOf(ws.policy);
  const caps = facts.captures.get(b.id) ?? [];
  const invs = facts.invoices.get(b.id) ?? [];
  const pays = facts.payouts.get(b.id) ?? [];
  const live = caps.filter((c) => c.status === "COMPLETED" || c.status === "PENDING");
  const fallback = invs.filter((i) => i.kind === "fallback" && i.status !== "cancelled");
  const extraWork = invs.filter((i) => i.kind === "extra_work" && i.status !== "cancelled" && i.status !== "draft");

  let charged: BookingRow["charged"] = null;
  if (live.length > 0) {
    const cents = live.reduce((s, c) => s + c.amountCents, 0);
    const kind = live[live.length - 1].kind;
    const pending = live.some((c) => c.status === "PENDING");
    charged = {
      amount: usd(cents),
      label: pending
        ? "charge pending"
        : kind === "full"
          ? "charged"
          : kind === "no_show_fee"
            ? "no-show fee"
            : "late-cancel fee",
    };
  } else if (fallback.some((i) => i.status === "paid")) {
    const paid = fallback.find((i) => i.status === "paid")!;
    charged = { amount: usd(paid.paidCents), label: "paid by invoice" };
  }

  let extra: string | null = null;
  if (extraWork.length > 0) {
    const total = usd(extraWork.reduce((s, i) => s + i.totalCents, 0));
    const allPaid = extraWork.every((i) => i.status === "paid");
    const paidOut =
      allPaid &&
      extraWork.every((i) =>
        pays.some((p) => p.source === "invoice" && p.sourceId === i.id && p.status === "succeeded"),
      );
    extra = `Extra work ${paidOut ? "paid out" : allPaid ? "paid" : "invoiced"} · ${total}`;
  }

  const declined = caps.find((c) => c.status === "DECLINED" || c.status === "FAILED");
  const dueCents =
    b.status === "completed"
      ? b.priceCents
      : b.status === "no_show" || b.status === "cancelled"
        ? b.noShowFeeCents
        : (declined?.amountCents ?? b.priceCents);
  const retryable = retryablePayouts(pays);
  const keys = facts.inFlight.get(b.id) ?? [];

  return {
    id: b.id,
    ref: b.ref,
    sample: b.sample,
    status: b.status,
    flag: b.paymentIssue,
    serviceName: b.serviceName,
    ...appointmentLabel(b.slotStart, b.slotEnd, now, ws.timezone),
    slotStart: b.slotStart.toISOString(),
    past: b.slotEnd.getTime() < now.getTime(),
    started: b.slotStart.getTime() <= now.getTime(),
    customer: firstName(names.customer),
    technician: firstName(names.technician),
    hold: usd(b.priceCents),
    noShowFee: usd(b.noShowFeeCents),
    charged,
    extra,
    due: usd(dueCents),
    failedPayout: retryable[0]
      ? {
          id: retryable[0].id,
          amount: usd(retryable[0].amountCents),
          technician: firstName(retryable[0].technicianName),
        }
      : null,
    actions: availableActions(
      {
        status: b.status,
        flag: b.paymentIssue,
        sample: b.sample,
        cancelReason: b.cancelReason,
        slotEnd: b.slotEnd,
        jobDone: facts.jobDone.has(b.id),
        captureInFlight: keys.some((k) => k.startsWith("capture:")),
        anyInFlight: keys.length > 0,
        fallbackInvoice: fallback.length > 0,
        retryablePayout: retryable.length > 0,
      },
      now,
    ),
    busy: keys.length > 0,
    lateNow: isLateCancellation(policy, b.slotStart, now),
    cancelWindowHours: policy.cancellationWindowHours,
  };
}

/** The workspace's bookings with what the list and the actions need, newest first. */
async function loadBookings(db: Db, ws: Workspace, now: Date) {
  const rows = await db
    .select({ booking: bookings, customer: customers.name, technician: technicians.name })
    .from(bookings)
    .leftJoin(customers, eq(customers.id, bookings.customerId))
    .innerJoin(technicians, eq(technicians.id, bookings.technicianId))
    .where(eq(bookings.workspaceId, ws.id))
    .orderBy(desc(bookings.createdAt))
    .limit(BOOKING_LIMIT);
  const facts = await loadFacts(
    db,
    rows.map((r) => r.booking.id),
  );
  return {
    raw: rows.map((r) => r.booking),
    customers: new Map(rows.flatMap((r) => (r.customer ? [[r.booking.id, firstName(r.customer)] as const] : []))),
    facts,
    rows: rows.map((r) => bookingRow(r.booking, { customer: r.customer, technician: r.technician }, facts, ws, now)),
  };
}

/**
 * Sample history is inserted in one go when a demo copy is made, so its capture and payout rows carry
 * that moment; the story's own times are in its booking events.
 */
function sampleTimes(raw: BookingDb[], events: { bookingId: string; toStatus: string | null; at: Date }[]) {
  const sample = new Set(raw.filter((b) => b.sample).map((b) => b.id));
  const at = new Map<string, Date>();
  for (const e of events) if (sample.has(e.bookingId) && e.toStatus) at.set(`${e.bookingId}:${e.toStatus}`, e.at);
  return (b: BookingDb, toStatus: "captured" | "paid_out") => (b.sample ? at.get(`${b.id}:${toStatus}`) : undefined);
}

/** Captures, holds, releases, invoices and payouts as one ledger, newest first (SPEC §18 Payments). */
async function loadLedger(
  db: Db,
  ws: Workspace,
  raw: BookingDb[],
  customers: Map<string, string>,
  facts: Facts,
  now: Date,
): Promise<LedgerEntry[]> {
  if (raw.length === 0) return [];
  const byId = new Map(raw.map((b) => [b.id, b]));
  const holds = await db
    .select()
    .from(bookingEvents)
    .where(
      and(
        inArray(
          bookingEvents.bookingId,
          raw.map((b) => b.id),
        ),
        inArray(bookingEvents.toStatus, ["authorized", "voided", "captured", "paid_out"]),
      ),
    );
  const sampleAt = sampleTimes(raw, holds);
  const entries: (Omit<LedgerEntry, "at" | "atLabel"> & { at: Date })[] = [];
  const base = (b: BookingDb) => ({
    bookingId: b.id,
    ref: b.ref,
    sample: b.sample,
    // IDs belong in the detail view only (docs/design-system.md): the service and the customer here.
    sub: [b.serviceName, customers.get(b.id)].filter(Boolean).join(" · "),
  });

  for (const e of holds) {
    if (e.toStatus !== "authorized" && e.toStatus !== "voided") continue;
    const b = byId.get(e.bookingId)!;
    const approved = e.toStatus === "authorized";
    entries.push({
      ...base(b),
      id: `e-${e.id}`,
      at: e.at,
      kind: approved ? "hold" : "release",
      text: approved ? `PayPal hold approved · ${usd(b.priceCents)}` : "Hold released",
      title: approved ? "PayPal hold approved" : "Hold released",
      amount: usd(b.priceCents),
      sign: "",
      status: approved ? { label: "Approved", tone: "brand" } : { label: "Nothing charged", tone: "neutral" },
      tone: approved ? "brand" : "neutral",
    });
  }
  for (const [bookingId, caps] of facts.captures) {
    const b = byId.get(bookingId)!;
    for (const c of caps) {
      const title = CAPTURE_KIND[c.kind] ?? "Charged";
      const ok = c.status === "COMPLETED";
      const failed = c.status === "DECLINED" || c.status === "FAILED";
      entries.push({
        ...base(b),
        id: `c-${c.id}`,
        at: sampleAt(b, "captured") ?? c.createdAt,
        kind: failed ? "problem" : "charge",
        text: failed
          ? `PayPal declined the charge · ${usd(c.amountCents)}`
          : c.kind === "full"
            ? `Charged ${usd(c.amountCents)}`
            : `${title} · ${usd(c.amountCents)}`,
        title: failed ? "Charge declined" : title,
        amount: usd(c.amountCents),
        sign: ok ? "+" : "",
        status: { label: captureStatusLabel(c.status), tone: ok ? "success" : failed ? "danger" : "warning" },
        tone: ok ? "success" : failed ? "danger" : "warning",
      });
    }
  }
  for (const [bookingId, invs] of facts.invoices) {
    const b = byId.get(bookingId)!;
    for (const i of invs) {
      const line = invoiceLine(i);
      if (!line) continue;
      entries.push({
        ...base(b),
        id: `i-${i.id}`,
        at: i.status === "sent" ? i.createdAt : i.updatedAt,
        kind: "invoice",
        text: line.text,
        title: i.kind === "fallback" ? "Invoice for the visit" : "Extra-work invoice",
        amount: usd(i.status === "paid" ? i.paidCents || i.totalCents : i.totalCents),
        sign: i.status === "paid" ? "+" : "",
        status: { label: invoiceStatusLabel(i.status), tone: line.tone },
        tone: line.tone,
      });
    }
  }
  for (const [bookingId, pays] of facts.payouts) {
    const b = byId.get(bookingId)!;
    for (const p of pays) {
      const tech = firstName(p.technicianName);
      const line = payoutLine(p, tech);
      entries.push({
        ...base(b),
        id: `p-${p.id}`,
        at:
          sampleAt(b, "paid_out") ?? (p.status === "pending" || p.status === "processing" ? p.createdAt : p.updatedAt),
        kind: line.kind,
        text: line.text,
        title: `Technician payout · ${tech}`,
        amount: usd(p.amountCents),
        sign: "−",
        status: { label: payoutStatusLabel(p.status), tone: payoutTone(p.status) },
        tone: line.tone,
      });
    }
  }
  return entries
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, LEDGER_LIMIT)
    .map((e) => ({ ...e, at: e.at.toISOString(), atLabel: momentLabel(e.at, now, ws.timezone) }));
}

const num = (column: ReturnType<typeof sql>) => column.mapWith(Number);

/** The headline numbers (SPEC §18), over the whole workspace, sample history included and labelled. */
async function loadKpis(db: Db, ws: Workspace) {
  const [b] = await db
    .select({
      confirmed: num(sql`count(*) filter (where ${bookings.authorizedAt} is not null)`),
      confirmedSample: num(sql`count(*) filter (where ${bookings.authorizedAt} is not null and ${bookings.sample})`),
      awaiting: num(sql`count(*) filter (where ${bookings.status} = 'pending_payment')`),
      secured: num(sql`coalesce(sum(${bookings.priceCents}) filter (where ${bookings.authorizedAt} is not null), 0)`),
      securedSample: num(
        sql`coalesce(sum(${bookings.priceCents}) filter (where ${bookings.authorizedAt} is not null and ${bookings.sample}), 0)`,
      ),
      onHold: num(sql`coalesce(sum(${bookings.priceCents}) filter (where ${bookings.status} = 'authorized'), 0)`),
      onHoldCount: num(sql`count(*) filter (where ${bookings.status} = 'authorized')`),
    })
    .from(bookings)
    .where(eq(bookings.workspaceId, ws.id));
  const [c] = await db
    .select({
      captured: num(sql`coalesce(sum(${captures.amountCents}) filter (where ${captures.status} = 'COMPLETED'), 0)`),
      capturedSample: num(
        sql`coalesce(sum(${captures.amountCents}) filter (where ${captures.status} = 'COMPLETED' and ${bookings.sample}), 0)`,
      ),
      fees: num(
        sql`coalesce(sum(${captures.amountCents}) filter (where ${captures.status} = 'COMPLETED' and ${captures.kind} <> 'full'), 0)`,
      ),
      feeCount: num(sql`count(*) filter (where ${captures.status} = 'COMPLETED' and ${captures.kind} <> 'full')`),
      feesSample: num(
        sql`coalesce(sum(${captures.amountCents}) filter (where ${captures.status} = 'COMPLETED' and ${captures.kind} <> 'full' and ${bookings.sample}), 0)`,
      ),
    })
    .from(captures)
    .innerJoin(bookings, eq(bookings.id, captures.bookingId))
    .where(eq(bookings.workspaceId, ws.id));
  const [i] = await db
    .select({
      paid: num(sql`coalesce(sum(${invoices.paidCents}) filter (where ${invoices.status} = 'paid'), 0)`),
      paidSample: num(
        sql`coalesce(sum(${invoices.paidCents}) filter (where ${invoices.status} = 'paid' and ${bookings.sample}), 0)`,
      ),
    })
    .from(invoices)
    .innerJoin(bookings, eq(bookings.id, invoices.bookingId))
    .where(eq(bookings.workspaceId, ws.id));
  const [p] = await db
    .select({
      sent: num(sql`coalesce(sum(${payouts.amountCents}) filter (where ${payouts.status} = 'succeeded'), 0)`),
      sentCount: num(sql`count(*) filter (where ${payouts.status} = 'succeeded')`),
      sentSample: num(
        sql`coalesce(sum(${payouts.amountCents}) filter (where ${payouts.status} = 'succeeded' and ${payouts.sample}), 0)`,
      ),
      inFlight: num(
        sql`coalesce(sum(${payouts.amountCents}) filter (where ${payouts.status} in ('pending', 'processing')), 0)`,
      ),
    })
    .from(payouts)
    .where(eq(payouts.workspaceId, ws.id));
  const [k] = await db
    .select({
      calls: num(sql`count(*)`),
      callsSample: num(sql`count(*) filter (where ${calls.sample})`),
    })
    .from(calls)
    .where(and(eq(calls.workspaceId, ws.id), eq(calls.lab, false), ne(calls.status, "created")));

  const sampleNote = (cents: number) => (cents > 0 ? `incl. ${usd(cents)} sample` : null);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [
    {
      key: "calls",
      label: "Calls answered",
      value: String(k.calls),
      caption: "Chat and web calls",
      sample: k.callsSample > 0 ? `incl. ${k.callsSample} sample` : null,
    },
    {
      key: "bookings",
      label: "Bookings",
      value: String(b.confirmed),
      caption: b.awaiting > 0 ? `${b.awaiting} waiting for approval` : "With an approved hold",
      sample: b.confirmedSample > 0 ? `incl. ${b.confirmedSample} sample` : null,
    },
    {
      key: "secured",
      label: "Hold value secured",
      value: usd(b.secured),
      caption: b.onHoldCount > 0 ? `${usd(b.onHold)} on hold now` : "Nothing on hold right now",
      sample: sampleNote(b.securedSample),
    },
    {
      key: "revenue",
      label: "Captured revenue",
      value: usd(c.captured + i.paid),
      caption: i.paid > 0 ? `incl. ${usd(i.paid)} by invoice` : "Charged through PayPal",
      sample: sampleNote(c.capturedSample + i.paidSample),
    },
    {
      key: "fees",
      label: "No-show & late fees",
      value: usd(c.fees),
      caption: c.feeCount > 0 ? `${plural(c.feeCount, "fee")} recovered` : "No fees so far",
      sample: sampleNote(c.feesSample),
    },
    {
      key: "payouts",
      label: "Payouts sent",
      value: usd(p.sent),
      caption: p.inFlight > 0 ? `${usd(p.inFlight)} on the way` : plural(p.sentCount, "payout"),
      sample: sampleNote(p.sentSample),
    },
  ];
}

export type CallRow = {
  id: string;
  channel: "chat" | "web" | "phone";
  title: string;
  atLabel: string;
  duration: string | null;
  live: boolean;
  bookingStatus: string | null;
  bookingFlag: string | null;
  bookingRef: string | null;
  outcome: string;
  sample: boolean;
};

type SummaryJson = {
  headline?: unknown;
  problem?: unknown;
  outcome?: unknown;
  follow_up?: unknown;
};

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

async function loadCalls(db: Db, ws: Workspace, now: Date): Promise<CallRow[]> {
  const rows = await db
    .select({
      id: calls.id,
      channel: calls.channel,
      status: calls.status,
      startedAt: calls.startedAt,
      endedAt: calls.endedAt,
      createdAt: calls.createdAt,
      durationS: calls.durationS,
      summary: calls.summary,
      sample: calls.sample,
      caller: calls.caller,
      lastAt: sql<string | null>`${calls.messages} -> -1 ->> 'at'`,
    })
    .from(calls)
    .where(and(eq(calls.workspaceId, ws.id), eq(calls.lab, false)))
    .orderBy(desc(calls.createdAt))
    .limit(CALL_LIMIT);
  const linked = rows.length
    ? await db
        .select({
          callId: bookings.callId,
          ref: bookings.ref,
          status: bookings.status,
          flag: bookings.paymentIssue,
          createdAt: bookings.createdAt,
        })
        .from(bookings)
        .where(
          and(
            eq(bookings.workspaceId, ws.id),
            inArray(
              bookings.callId,
              rows.map((r) => r.id),
            ),
          ),
        )
        .orderBy(desc(bookings.createdAt))
    : [];
  return rows.map((r) => {
    const summary = (r.summary ?? null) as SummaryJson | null;
    const mine = linked.filter((l) => l.callId === r.id);
    const booking = mine.find((l) => l.status !== "expired") ?? mine[0] ?? null;
    const start = r.startedAt ?? r.createdAt;
    const chatEnd = r.lastAt ? new Date(r.lastAt) : null;
    const seconds =
      r.durationS ??
      (r.channel === "chat" && chatEnd && !Number.isNaN(chatEnd.getTime())
        ? Math.max(0, (chatEnd.getTime() - start.getTime()) / 1000)
        : null);
    const name = text(r.caller?.firstName, 40);
    const live = r.channel !== "chat" && r.status === "in-progress";
    return {
      id: r.id,
      channel: r.channel,
      title:
        text(summary?.headline, 80) ??
        (r.channel === "chat" ? `Chat${name ? ` with ${name}` : ""}` : `Web call${name ? ` with ${name}` : ""}`),
      atLabel: momentLabel(start, now, ws.timezone),
      duration: durationLabel(seconds),
      live,
      bookingStatus: booking?.status ?? null,
      bookingFlag: booking?.flag ?? null,
      bookingRef: booking?.ref ?? null,
      outcome: booking ? "Booked" : (summaryOutcomeLabel(summary?.outcome) ?? (live ? "On the line" : "No booking")),
      sample: r.sample,
    };
  });
}

async function loadOutbox(db: Db, ws: Workspace, now: Date) {
  const rows = await db
    .select({
      id: outboxEmails.id,
      subject: outboxEmails.subject,
      status: outboxEmails.status,
      template: outboxEmails.template,
      createdAt: outboxEmails.createdAt,
      ref: bookings.ref,
    })
    .from(outboxEmails)
    .leftJoin(bookings, eq(bookings.id, outboxEmails.bookingId))
    .where(eq(outboxEmails.workspaceId, ws.id))
    .orderBy(desc(outboxEmails.createdAt))
    .limit(OUTBOX_LIMIT);
  return rows.map((m) => ({
    id: m.id,
    subject: m.subject,
    ref: m.ref,
    atLabel: momentLabel(m.createdAt, now, ws.timezone),
    status: OUTBOX_STATUS[m.status] ?? { label: "Queued", tone: "neutral" as const },
  }));
}

/** The price list and the rules the agent quotes (SPEC §18): straight from this workspace's catalog. */
async function loadCatalog(db: Db, ws: Workspace) {
  const [svc, add, techs] = await Promise.all([
    db
      .select()
      .from(services)
      .where(and(eq(services.workspaceId, ws.id), eq(services.active, true)))
      .orderBy(asc(services.sortOrder)),
    db
      .select()
      .from(addonItems)
      .where(and(eq(addonItems.workspaceId, ws.id), eq(addonItems.active, true)))
      .orderBy(asc(addonItems.unitPriceCents)),
    db
      .select()
      .from(technicians)
      .where(and(eq(technicians.workspaceId, ws.id), eq(technicians.active, true)))
      .orderBy(asc(technicians.name)),
  ]);
  const policy = policyOf(ws.policy);
  const share = (bps: number) => `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(1)}%`;
  const shares = [...new Set(techs.map((t) => t.payoutShareBps))];
  return {
    services: svc.map((s) => ({
      key: s.key,
      name: s.name,
      description: s.description,
      category: s.category === "plumbing" ? "Plumbing" : "Electrical",
      emergency: s.isEmergency,
      duration: durationLabel(s.durationMin * 60)!,
      price: usd(s.priceCents),
      noShowFee: usd(s.noShowFeeCents),
    })),
    addons: add.map((a) => ({
      key: a.key,
      name: a.name,
      unit: a.unit,
      price: usd(a.unitPriceCents),
      unitPriceCents: a.unitPriceCents,
    })),
    technicians: techs.map((t) => ({
      name: t.name,
      skills: t.skills.map((s) => (s === "plumbing" ? "Plumbing" : "Electrical")).join(", "),
      share: share(t.payoutShareBps),
    })),
    policy: {
      cancellationWindowHours: policy.cancellationWindowHours,
      bookingWindowDays: policy.bookingWindowDays,
      holdTtlMinutes: policy.holdTtlMinutes,
      staleHoldHours: policy.staleHoldHours,
      technicianShare: shares.length === 1 ? share(shares[0]) : shares.map(share).join(" / "),
    },
  };
}

/** Per-technician payout totals (SPEC §18 Payments & payouts). */
function payoutTotals(facts: Facts, catalog: Awaited<ReturnType<typeof loadCatalog>>) {
  const all = [...facts.payouts.values()].flat();
  return catalog.technicians.map((t) => {
    const mine = all.filter((p) => p.technicianName === t.name);
    const paid = mine.filter((p) => p.status === "succeeded");
    const moving = mine.filter((p) => p.status === "pending" || p.status === "processing");
    const failed = retryablePayouts(mine).length;
    const sampleCents = paid.filter((p) => p.sample).reduce((s, p) => s + p.amountCents, 0);
    return {
      name: t.name,
      share: t.share,
      paid: usd(paid.reduce((s, p) => s + p.amountCents, 0)),
      paidCount: paid.length,
      sample: sampleCents > 0 ? `incl. ${usd(sampleCents)} sample` : null,
      onTheWay: moving.length ? usd(moving.reduce((s, p) => s + p.amountCents, 0)) : null,
      failed,
    };
  });
}

/** One poll of the dashboard: everything the page shows (GET /api/dashboard/state). */
export async function dashboardState(db: Db, ws: Workspace, now: Date = new Date()) {
  const [{ raw, customers: customerNames, facts, rows }, kpis, callRows, outbox, catalog] = await Promise.all([
    loadBookings(db, ws, now),
    loadKpis(db, ws),
    loadCalls(db, ws, now),
    loadOutbox(db, ws, now),
    loadCatalog(db, ws),
  ]);
  const ledger = await loadLedger(db, ws, raw, customerNames, facts, now);
  const live = rows.filter((r) => !r.sample);
  const attention = [
    ...live.filter((r) => r.flag).map((r) => ({ bookingId: r.id, kind: "flag" as const, flag: r.flag })),
    ...live
      .filter((r) => r.status === "authorized" && r.past && !r.flag)
      .map((r) => ({ bookingId: r.id, kind: "overdue" as const, flag: null })),
  ];
  const upcoming = rows
    .filter((r) => r.status === "authorized" && !r.past)
    .sort((a, b) => a.slotStart.localeCompare(b.slotStart))
    .slice(0, 5)
    .map((r) => r.id);
  return {
    business: { name: ws.name, label: ws.label },
    kpis,
    attention,
    upcoming,
    bookings: rows,
    calls: callRows,
    ledger,
    payoutTotals: payoutTotals(facts, catalog),
    catalog,
    outbox,
  };
}

export type DashboardState = Awaited<ReturnType<typeof dashboardState>>;

// ─── Detail views ─────────────────────────────────────────────────────────────────────────────────

/** A booking sheet: summary, timeline and every PayPal object with its ID (GET /api/dashboard/bookings/[id]). */
export async function bookingDetail(db: Db, ws: Workspace, bookingId: string, now: Date = new Date()) {
  if (!/^[0-9a-f-]{36}$/.test(bookingId)) return null;
  const [row] = await db
    .select({
      booking: bookings,
      customer: customers.name,
      email: customers.email,
      technician: technicians.name,
    })
    .from(bookings)
    .leftJoin(customers, eq(customers.id, bookings.customerId))
    .innerJoin(technicians, eq(technicians.id, bookings.technicianId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.workspaceId, ws.id)));
  if (!row) return null;
  const b = row.booking;
  const [facts, events, orders, auths, call] = await Promise.all([
    loadFacts(db, [b.id]),
    db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, b.id)).orderBy(asc(bookingEvents.at)),
    db.select().from(paypalOrders).where(eq(paypalOrders.bookingId, b.id)).orderBy(asc(paypalOrders.attempt)),
    db.select().from(authorizations).where(eq(authorizations.bookingId, b.id)).orderBy(asc(authorizations.createdAt)),
    b.callId
      ? db
          .select({ id: calls.id, channel: calls.channel, summary: calls.summary })
          .from(calls)
          .where(and(eq(calls.id, b.callId), eq(calls.workspaceId, ws.id)))
      : Promise.resolve([]),
  ]);
  const at = (d: Date) => momentLabel(d, now, ws.timezone);
  const sampleAt = sampleTimes([b], events);
  const paypalAuthId = new Map(auths.map((a) => [a.id, a.paypalAuthorizationId]));
  // Booking events, plus the invoices (they have their own lifecycle and no booking events), by time.
  const timeline = [
    ...events.flatMap((e) => {
      const line = eventLine(e, b);
      return line ? [{ id: e.id, at: e.at, actor: actorLabel(e.actor), ...line }] : [];
    }),
    ...(facts.invoices.get(b.id) ?? []).flatMap((i) => {
      const sent = i.paypalInvoiceId ? invoiceLine({ ...i, status: "sent" }) : null;
      const final = i.status === "paid" || i.status === "cancelled" ? invoiceLine(i) : null;
      return [
        ...(sent ? [{ id: `i-${i.id}`, at: i.createdAt, actor: actorLabel("owner"), ...sent }] : []),
        ...(final ? [{ id: `i-${i.id}-end`, at: i.updatedAt, actor: actorLabel("webhook"), ...final }] : []),
      ];
    }),
  ]
    .sort((x, y) => x.at.getTime() - y.at.getTime())
    .map(({ at: when, ...rest }) => ({ ...rest, atLabel: at(when) }));
  const callRow = call[0];
  const callSummary = (callRow?.summary ?? null) as SummaryJson | null;
  return {
    booking: bookingRow(b, { customer: row.customer, technician: row.technician }, facts, ws, now),
    technicianName: row.technician,
    customerEmail: row.email,
    problem: text(b.problemSummary, 500),
    timeline,
    payments: {
      orders: orders.map((o) => ({
        id: o.paypalOrderId,
        attempt: o.attempt,
        status: orderStatusLabel(o.status),
        amount: usd(o.amountCents),
        atLabel: at(o.createdAt),
      })),
      authorizations: auths.map((a) => ({
        id: a.paypalAuthorizationId,
        renewalOf: a.parentAuthorizationId ? (paypalAuthId.get(a.parentAuthorizationId) ?? null) : null,
        status: authorizationStatusLabel(a.status),
        role: a.role === "active" ? null : a.role === "replaced" ? "Replaced" : "Stray hold",
        amount: usd(a.amountCents),
        validUntil: a.validUntil ? at(a.validUntil) : null,
        atLabel: at(a.createdAt),
      })),
      captures: (facts.captures.get(b.id) ?? []).map((c) => ({
        id: c.paypalCaptureId,
        title: CAPTURE_KIND[c.kind] ?? "Charged",
        amount: usd(c.amountCents),
        status: captureStatusLabel(c.status),
        atLabel: at(sampleAt(b, "captured") ?? c.createdAt),
      })),
      invoices: (facts.invoices.get(b.id) ?? []).map((i) => ({
        number: i.invoiceNumber,
        id: i.paypalInvoiceId,
        title: i.kind === "fallback" ? "Invoice for the visit" : "Extra-work invoice",
        total: usd(i.totalCents),
        paid: i.status === "paid" ? usd(i.paidCents) : null,
        status: invoiceStatusLabel(i.status),
        payerViewUrl: i.payerViewUrl && /^https:\/\//.test(i.payerViewUrl) ? i.payerViewUrl : null,
        items: i.items.map((l) => ({
          name: l.name,
          quantity: l.quantity,
          amount: usd(l.unitAmountCents * l.quantity),
        })),
        atLabel: at(i.createdAt),
      })),
      payouts: (facts.payouts.get(b.id) ?? []).map((p) => ({
        id: p.id,
        technician: firstName(p.technicianName),
        amount: usd(p.amountCents),
        status: { label: payoutStatusLabel(p.status), tone: payoutTone(p.status) },
        attempt: p.attemptNo,
        forWhat: p.source === "capture" ? "For the visit" : "For an invoice",
        batchId: p.paypalBatchId,
        itemId: p.paypalItemId,
        atLabel: at(sampleAt(b, "paid_out") ?? p.createdAt),
      })),
    },
    call: callRow
      ? {
          id: callRow.id,
          title: text(callSummary?.headline, 80) ?? (callRow.channel === "chat" ? "Chat" : "Web call"),
          channel: callRow.channel,
        }
      : null,
  };
}

export type BookingDetail = NonNullable<Awaited<ReturnType<typeof bookingDetail>>>;

export type TranscriptLine = {
  speaker: "customer" | "agent";
  text: string;
  /** A fixed payment notice posted by the server, by kind (the sheet colors it accordingly). */
  notice?: "authorized" | "declined_retry" | "expired";
};

/** Vapi's "AI: …\nUser: …" transcript as speaker bubbles; one speaker's consecutive lines are merged. */
export function voiceLines(transcript: string | null): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of (transcript ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(AI|Assistant|Bot|User|Customer):\s*(.*)$/i.exec(line);
    const speaker = m ? (/^(user|customer)$/i.test(m[1]) ? "customer" : "agent") : (out.at(-1)?.speaker ?? "agent");
    const content = (m ? m[2] : line).trim();
    if (!content) continue;
    const last = out.at(-1);
    if (last && last.speaker === speaker) last.text = `${last.text} ${content}`;
    else out.push({ speaker, text: content });
  }
  return out;
}

/** A call sheet: the AI summary (untrusted), the transcript and the linked booking. */
export async function callDetail(db: Db, ws: Workspace, callId: string, now: Date = new Date()) {
  if (!/^[0-9a-f-]{36}$/.test(callId)) return null;
  const [call] = await db
    .select({
      id: calls.id,
      channel: calls.channel,
      status: calls.status,
      sample: calls.sample,
      lab: calls.lab,
      startedAt: calls.startedAt,
      createdAt: calls.createdAt,
      durationS: calls.durationS,
      transcript: calls.transcript,
      messages: calls.messages,
      summary: calls.summary,
      caller: calls.caller,
    })
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.workspaceId, ws.id)));
  if (!call || call.lab) return null;
  const linked = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.callId, call.id), eq(bookings.workspaceId, ws.id)))
    .orderBy(desc(bookings.createdAt));
  const summary = (call.summary ?? null) as SummaryJson | null;
  const lines: TranscriptLine[] =
    call.channel === "chat"
      ? chatLines(call)
          .filter((l) => typeof l.text === "string" && l.text.trim())
          .map((l) => ({
            speaker: l.role === "user" ? ("customer" as const) : ("agent" as const),
            text: l.text.slice(0, 2_000),
            ...(l.notice ? { notice: l.notice } : {}),
          }))
      : voiceLines(call.transcript);
  const start = call.startedAt ?? call.createdAt;
  return {
    id: call.id,
    channel: call.channel,
    sample: call.sample,
    atLabel: momentLabel(start, now, ws.timezone),
    duration: durationLabel(call.durationS),
    caller: text(call.caller?.firstName, 40),
    summary: summary
      ? {
          headline: text(summary.headline, 80),
          problem: text(summary.problem, 300),
          outcome: summaryOutcomeLabel(summary.outcome),
          followUp: text(summary.follow_up, 200),
        }
      : null,
    lines: lines.slice(-200),
    bookings: linked.map((b) => ({
      id: b.id,
      ref: b.ref,
      serviceName: b.serviceName,
      status: b.status,
      flag: b.paymentIssue,
      ...appointmentLabel(b.slotStart, b.slotEnd, now, ws.timezone),
    })),
  };
}

export type CallDetail = NonNullable<Awaited<ReturnType<typeof callDetail>>>;

/** One outbox email for the sandboxed preview (GET /api/dashboard/outbox/[id]). */
export async function emailPreview(db: Db, ws: Workspace, emailId: string, now: Date = new Date()) {
  if (!/^[0-9a-f-]{36}$/.test(emailId)) return null;
  const [m] = await db
    .select({
      id: outboxEmails.id,
      subject: outboxEmails.subject,
      html: outboxEmails.html,
      status: outboxEmails.status,
      createdAt: outboxEmails.createdAt,
      ref: bookings.ref,
    })
    .from(outboxEmails)
    .leftJoin(bookings, eq(bookings.id, outboxEmails.bookingId))
    .where(and(eq(outboxEmails.id, emailId), eq(outboxEmails.workspaceId, ws.id)));
  if (!m) return null;
  return {
    id: m.id,
    subject: m.subject,
    ref: m.ref,
    atLabel: momentLabel(m.createdAt, now, ws.timezone),
    status: OUTBOX_STATUS[m.status] ?? { label: "Queued", tone: "neutral" as const },
    html: previewHtml(m.html ?? ""),
  };
}

/** Links in the sandboxed preview open in a new tab (the frame itself runs no scripts). */
export function previewHtml(html: string): string {
  const base = '<base target="_blank">';
  return /<html[^>]*>/i.test(html) ? html.replace(/<html([^>]*)>/i, `<html$1><head>${base}</head>`) : base + html;
}
