import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import { bookingEvents, bookings } from "@/db/schema";
import type { Executor, Tx } from "@/db/types";

import { type BookingStatus, canSetFlag, canTransition, conflictMessage, type PaymentIssue } from "./booking-state";

export type Booking = typeof bookings.$inferSelect;
export type Actor = (typeof bookingEvents.$inferInsert)["actor"];

export class BookingNotFoundError extends Error {
  readonly status = 404;
  constructor(readonly bookingId: string) {
    super("Booking not found");
    this.name = "BookingNotFoundError";
  }
}

/** A sibling request lost the race (§8.4.2): a visible 409, never a fake success. */
export class TransitionConflictError extends Error {
  readonly status = 409;
  constructor(
    readonly current: BookingStatus,
    readonly attempted: BookingStatus | `flag:${string}`,
  ) {
    super(conflictMessage(current));
    this.name = "TransitionConflictError";
  }
}

export async function lockBooking(tx: Tx, bookingId: string): Promise<Booking> {
  const [row] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
  if (!row) throw new BookingNotFoundError(bookingId);
  return row;
}

type TransitionInput = {
  bookingId: string;
  /** One or more allowed source statuses; each pair must be in the transition table. */
  from: BookingStatus | readonly BookingStatus[];
  to: BookingStatus;
  actor: Actor;
  reason?: string;
  detail?: Record<string, unknown>;
  /** A flag for the new status. Flags never carry across a status change: omitted or null clears it. */
  flag?: PaymentIssue | null;
  /** Extra columns written in the same CAS (never status, version or the price snapshot). */
  patch?: Omit<PgUpdateSetSource<typeof bookings>, "status" | "version" | "priceCents" | "noShowFeeCents">;
};

export type TransitionResult = { booking: Booking; changed: boolean };

/**
 * Compare-and-set a status change inside a transaction (SPEC §8.4.1):
 * lock the row, check the source status, `UPDATE … WHERE status = from`, append a booking event.
 * - An exact repeat (this from → to is already in booking_events) is a silent no-op.
 * - Anything else that finds the booking elsewhere is a TransitionConflictError (409).
 */
export async function transitionBooking(tx: Tx, input: TransitionInput): Promise<TransitionResult> {
  const sources = (Array.isArray(input.from) ? input.from : [input.from]) as BookingStatus[];
  for (const from of sources) {
    if (!canTransition(from, input.to)) throw new Error(`illegal transition ${from} -> ${input.to}`);
  }
  if (input.flag && !canSetFlag(input.to, input.flag))
    throw new Error(`flag ${input.flag} is not valid in ${input.to}`);

  const current = await lockBooking(tx, input.bookingId);
  if (!sources.includes(current.status)) {
    if (await alreadyRecorded(tx, input.bookingId, sources, input.to)) return { booking: current, changed: false };
    throw new TransitionConflictError(current.status, input.to);
  }

  // §8.3: a flag describes a problem in the current status; entering a new status resolves it (e.g. a
  // successful retry capture or a paid fallback invoice clears capture_failed). New flags are explicit.
  const nextFlag = input.flag ?? null;

  const now = new Date();
  const [updated] = await tx
    .update(bookings)
    .set({
      ...input.patch,
      status: input.to,
      paymentIssue: nextFlag,
      version: sql`${bookings.version} + 1`,
      statusChangedAt: now,
      updatedAt: now,
    })
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.status, current.status)))
    .returning();
  if (!updated) throw new TransitionConflictError(current.status, input.to);

  await tx.insert(bookingEvents).values({
    bookingId: input.bookingId,
    fromStatus: current.status,
    toStatus: input.to,
    flag: flagChange(current.paymentIssue, nextFlag),
    actor: input.actor,
    reason: input.reason ?? null,
    detail: input.detail ?? null,
  });
  return { booking: updated, changed: true };
}

async function alreadyRecorded(tx: Executor, bookingId: string, from: BookingStatus[], to: BookingStatus) {
  const [row] = await tx
    .select({ id: bookingEvents.id })
    .from(bookingEvents)
    .where(
      and(
        eq(bookingEvents.bookingId, bookingId),
        inArray(bookingEvents.fromStatus, from),
        eq(bookingEvents.toStatus, to),
      ),
    )
    .limit(1);
  return Boolean(row);
}

function flagChange(before: PaymentIssue | null, after: PaymentIssue | null): string | null {
  if (before === after) return null;
  return [before ? `-${before}` : null, after ? `+${after}` : null].filter(Boolean).join(" ");
}

/**
 * Sets or clears the payment flag without a status change (§8.3: flags move sideways).
 * `expect` limits the statuses the change may happen in; setting a flag also requires it to be valid there.
 * Returns false (no change) when the flag already has that value.
 */
export async function setPaymentIssue(
  tx: Tx,
  input: {
    bookingId: string;
    flag: PaymentIssue | null;
    /** Only clear this flag (when `flag` is null): leaves any other flag alone. */
    clearOnly?: PaymentIssue;
    expect?: readonly BookingStatus[];
    actor: Actor;
    reason?: string;
    detail?: Record<string, unknown>;
  },
): Promise<{ booking: Booking; changed: boolean }> {
  const current = await lockBooking(tx, input.bookingId);
  if (input.expect && !input.expect.includes(current.status)) {
    throw new TransitionConflictError(current.status, `flag:${input.flag ?? "clear"}`);
  }
  if (input.flag && !canSetFlag(current.status, input.flag)) {
    throw new TransitionConflictError(current.status, `flag:${input.flag}`);
  }
  if (input.flag === null && input.clearOnly && current.paymentIssue !== input.clearOnly) {
    return { booking: current, changed: false };
  }
  if (current.paymentIssue === input.flag) return { booking: current, changed: false };

  const [updated] = await tx
    .update(bookings)
    .set({ paymentIssue: input.flag, version: sql`${bookings.version} + 1`, updatedAt: new Date() })
    .where(eq(bookings.id, input.bookingId))
    .returning();
  await tx.insert(bookingEvents).values({
    bookingId: input.bookingId,
    fromStatus: null,
    toStatus: null,
    flag: flagChange(current.paymentIssue, input.flag),
    actor: input.actor,
    reason: input.reason ?? null,
    detail: input.detail ?? null,
  });
  return { booking: updated, changed: true };
}

/** A note in the audit log without any status or flag change (e.g. an orphan void, §9.10). */
export async function logBookingEvent(
  tx: Executor,
  input: { bookingId: string; actor: Actor; flag?: string; reason?: string; detail?: Record<string, unknown> },
): Promise<void> {
  await tx.insert(bookingEvents).values({
    bookingId: input.bookingId,
    fromStatus: null,
    toStatus: null,
    flag: input.flag ?? null,
    actor: input.actor,
    reason: input.reason ?? null,
    detail: input.detail ?? null,
  });
}
