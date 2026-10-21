import { and, eq, lt, sql } from "drizzle-orm";

import { paymentOperations } from "@/db/schema";
import type { Db } from "@/db/types";
import { isInProgress, PayPalApiError } from "@/server/paypal/errors";

/**
 * The idempotency ledger (SPEC §10.3). Every money operation runs under a deterministic key and a
 * deterministic PayPal-Request-Id:
 * - claim: INSERT … ON CONFLICT DO NOTHING; a `succeeded` row returns its stored result;
 * - a live `in_flight` row is waited for (≤ 5 s), then reported as in progress;
 * - an expired lease is taken over: PayPal is asked first (`probe`), then the call is repeated with the
 *   SAME request ID, so PayPal replays instead of acting twice;
 * - an unknown outcome stays `in_flight` (never `failed`); a definite business error becomes `failed`,
 *   and only an explicit owner retry with a new key may run it again.
 */

export const LEASE_MS = 60_000;
const WAIT_MS = 5_000;
const POLL_MS = 100;

export type OperationRow = typeof paymentOperations.$inferSelect;

/** Another worker holds the operation, or its outcome is unknown: the caller reports "processing" (202). */
export class OperationInProgressError extends Error {
  readonly status = 202;
  constructor(readonly key: string) {
    super("This payment step is still in progress.");
    this.name = "OperationInProgressError";
  }
}

/** The operation failed definitively before; only an explicit retry with a new key may run it again. */
export class OperationFailedError extends Error {
  readonly status = 409;
  constructor(
    readonly key: string,
    readonly lastError: string | null,
  ) {
    super(`This payment step failed: ${lastError ?? "unknown error"}`);
    this.name = "OperationFailedError";
  }
}

export type OperationSpec<R> = {
  key: string;
  kind: string;
  bookingId?: string | null;
  requestId: string;
  /** Performs the PayPal call(s). Must use `requestId` for its POST. Returns a JSON-safe result. */
  run: () => Promise<R>;
  /** Recovery only: ask PayPal whether the operation already happened; return its result if so. */
  probe?: () => Promise<R | null>;
  now?: () => Date;
  /** Override: is this error an unknown outcome (keep in flight) rather than a definite failure? */
  isUnknown?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

export type OperationOutcome<R> = { result: R; replayed: boolean };

/** A refusal raised inside `run` that is final for this key (e.g. "already captured"). */
export class DefiniteOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefiniteOperationError";
  }
}

/**
 * Only a PayPal business 4xx on the API call itself (or an explicit DefiniteOperationError) is a definite
 * failure. Everything else (network, 5xx, 409 in progress, OAuth trouble, our own DB errors) is an unknown
 * outcome: the row stays in flight and recovery GETs first, then retries with the same request ID.
 */
export function isDefiniteFailure(error: unknown): boolean {
  if (error instanceof DefiniteOperationError) return true;
  return (
    error instanceof PayPalApiError &&
    error.phase === "api" &&
    error.status >= 400 &&
    error.status < 500 &&
    !isInProgress(error)
  );
}

const describe = (error: unknown) =>
  error instanceof PayPalApiError
    ? `${error.status} ${error.issue ?? error.errorName ?? ""}`.trim()
    : error instanceof Error
      ? `${error.name}: ${error.message}`.slice(0, 300)
      : String(error).slice(0, 300);

export async function runOperation<R>(db: Db, spec: OperationSpec<R>): Promise<OperationOutcome<R>> {
  const now = spec.now ?? (() => new Date());
  const sleep = spec.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const [claimed] = await db
    .insert(paymentOperations)
    .values({
      key: spec.key,
      kind: spec.kind,
      bookingId: spec.bookingId ?? null,
      paypalRequestId: spec.requestId,
      state: "in_flight",
      leaseUntil: new Date(now().getTime() + LEASE_MS),
    })
    .onConflictDoNothing({ target: paymentOperations.key })
    .returning();
  if (claimed) return execute(db, spec, now, false);

  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const row = await load(db, spec.key);
    if (row.state === "succeeded") return { result: row.result as R, replayed: true };
    if (row.state === "failed") throw new OperationFailedError(spec.key, row.lastError);
    if (row.leaseUntil.getTime() <= now().getTime()) {
      const [taken] = await db
        .update(paymentOperations)
        .set({
          leaseUntil: new Date(now().getTime() + LEASE_MS),
          attempts: sql`${paymentOperations.attempts} + 1`,
          updatedAt: now(),
        })
        .where(
          and(
            eq(paymentOperations.key, spec.key),
            eq(paymentOperations.state, "in_flight"),
            lt(paymentOperations.leaseUntil, now()),
          ),
        )
        .returning();
      if (taken) return execute(db, spec, now, true);
    }
    if (Date.now() >= deadline) throw new OperationInProgressError(spec.key);
    await sleep(POLL_MS);
  }
}

async function load(db: Db, key: string): Promise<OperationRow> {
  const [row] = await db.select().from(paymentOperations).where(eq(paymentOperations.key, key));
  if (!row) throw new Error(`ledger row ${key} vanished`);
  return row;
}

async function execute<R>(
  db: Db,
  spec: OperationSpec<R>,
  now: () => Date,
  recovering: boolean,
): Promise<OperationOutcome<R>> {
  try {
    const probed = recovering && spec.probe ? await spec.probe() : null;
    const result = probed ?? (await spec.run());
    await db
      .update(paymentOperations)
      .set({ state: "succeeded", result: result as unknown, lastError: null, updatedAt: now() })
      .where(eq(paymentOperations.key, spec.key));
    return { result, replayed: false };
  } catch (error) {
    const unknown = spec.isUnknown ? spec.isUnknown(error) : !isDefiniteFailure(error);
    await db
      .update(paymentOperations)
      .set(
        unknown
          ? // Outcome unknown: keep in flight; the lease expires and the reconciler GETs first (§10.3.4).
            { lastError: describe(error), updatedAt: now() }
          : { state: "failed", lastError: describe(error), updatedAt: now() },
      )
      .where(eq(paymentOperations.key, spec.key));
    throw unknown ? new OperationInProgressError(spec.key) : error;
  }
}

/**
 * Marks a succeeded call whose BUSINESS outcome is a refusal (e.g. a capture that came back DECLINED) as
 * failed, so an explicit owner retry may run it again under a new key (SPEC §10.3.1).
 */
export async function markOperationFailed(db: Db, key: string, reason: string): Promise<void> {
  await db
    .update(paymentOperations)
    .set({ state: "failed", lastError: reason.slice(0, 300), updatedAt: new Date() })
    .where(eq(paymentOperations.key, key));
}

/** True while any ledger row with this key prefix is in flight (SPEC §10.3.5: disables related buttons). */
export async function hasOperationInFlight(db: Db, bookingId: string, keyPrefix: string): Promise<boolean> {
  const [row] = await db
    .select({ id: paymentOperations.id })
    .from(paymentOperations)
    .where(
      and(
        eq(paymentOperations.bookingId, bookingId),
        eq(paymentOperations.state, "in_flight"),
        sql`${paymentOperations.key} like ${`${keyPrefix}%`}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The next retry key for an operation that failed: `<base>:retry-<n>` (SPEC §10.3.1). */
export async function nextRetryKey(db: Db, baseKey: string): Promise<{ key: string; n: number }> {
  const rows = await db
    .select({ key: paymentOperations.key, state: paymentOperations.state })
    .from(paymentOperations)
    .where(sql`${paymentOperations.key} = ${baseKey} or ${paymentOperations.key} like ${`${baseKey}:retry-%`}`);
  if (rows.some((r) => r.state !== "failed")) {
    throw new OperationFailedError(baseKey, "a previous attempt is still running or already succeeded");
  }
  const n = rows.length;
  return { key: n === 0 ? baseKey : `${baseKey}:retry-${n}`, n };
}
