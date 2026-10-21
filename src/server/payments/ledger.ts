import { and, eq, lt, sql } from "drizzle-orm";

import { paymentOperations } from "@/db/schema";
import type { Db, Executor } from "@/db/types";
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
 * A succeeded row is confirmed against the domain tables by the reconciler (`applied_at`), so a crash
 * between PayPal's answer and our own write is repaired too.
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

/** A refusal raised inside `run` that is final for this key (e.g. "already captured"). */
export class DefiniteOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefiniteOperationError";
  }
}

/** Statuses that say nothing about the operation itself: rate limits, timeouts and auth trouble. */
const TRANSIENT_4XX = new Set([401, 403, 408, 429]);

/**
 * Only a PayPal business 4xx on the API call itself (or an explicit DefiniteOperationError) is a definite
 * failure. Everything else (network, 5xx, 409 in progress, 429, 401/403, OAuth trouble, our own DB
 * errors) is an unknown outcome: the row stays in flight and recovery GETs first, then retries with the
 * same request ID.
 */
export function isDefiniteFailure(error: unknown): boolean {
  if (error instanceof DefiniteOperationError) return true;
  return (
    error instanceof PayPalApiError &&
    error.phase === "api" &&
    error.status >= 400 &&
    error.status < 500 &&
    !TRANSIENT_4XX.has(error.status) &&
    !isInProgress(error)
  );
}

export type OperationOutcome<R> = { result: R; replayed: boolean };

export type OperationSpec<R> = {
  key: string;
  kind: string;
  bookingId?: string | null;
  requestId: string;
  /** Performs the PayPal call(s). Must use `requestId` for its POST. Returns a JSON-safe result. */
  run: () => Promise<R>;
  /**
   * Recovery only: ask PayPal whether the operation already happened; return its result if so. A probe
   * that throws never settles the row: the outcome stays unknown.
   */
  probe?: () => Promise<R | null>;
  now?: () => Date;
  /** The caller already claimed the row inside its own transaction (`claimOperation`). */
  preclaimed?: boolean;
  sleep?: (ms: number) => Promise<void>;
};

const describe = (error: unknown) =>
  error instanceof PayPalApiError
    ? `${error.status} ${error.issue ?? error.errorName ?? ""}`.trim()
    : error instanceof Error
      ? `${error.name}: ${error.message}`.slice(0, 300)
      : String(error).slice(0, 300);

/**
 * Claims an operation inside the caller's transaction, so a business check and the claim are atomic
 * (e.g. Retry capture vs Bill via invoice under the booking lock). Returns false if the key exists.
 */
export async function claimOperation(
  tx: Executor,
  spec: { key: string; kind: string; bookingId?: string | null; requestId: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .insert(paymentOperations)
    .values({
      key: spec.key,
      kind: spec.kind,
      bookingId: spec.bookingId ?? null,
      paypalRequestId: spec.requestId,
      state: "in_flight",
      leaseUntil: new Date(spec.now.getTime() + LEASE_MS),
    })
    .onConflictDoNothing({ target: paymentOperations.key })
    .returning({ id: paymentOperations.id });
  return rows.length > 0;
}

export async function runOperation<R>(db: Db, spec: OperationSpec<R>): Promise<OperationOutcome<R>> {
  const now = spec.now ?? (() => new Date());
  const sleep = spec.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (spec.preclaimed) return execute(db, spec, now, false);
  if (await claimOperation(db, { ...spec, now: now() })) return execute(db, spec, now, false);

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

async function settle(db: Db, key: string, now: () => Date, set: Partial<typeof paymentOperations.$inferInsert>) {
  await db
    .update(paymentOperations)
    .set({ ...set, updatedAt: now() })
    .where(and(eq(paymentOperations.key, key), eq(paymentOperations.state, "in_flight")));
}

async function execute<R>(
  db: Db,
  spec: OperationSpec<R>,
  now: () => Date,
  recovering: boolean,
): Promise<OperationOutcome<R>> {
  let probed: R | null = null;
  if (recovering && spec.probe) {
    try {
      probed = await spec.probe();
    } catch (error) {
      // A failed lookup says nothing about the operation: keep it unknown (SPEC §10.3.4).
      await settle(db, spec.key, now, { lastError: `probe: ${describe(error)}` });
      throw new OperationInProgressError(spec.key);
    }
  }
  try {
    const result = probed ?? (await spec.run());
    await settle(db, spec.key, now, { state: "succeeded", result: result as unknown, lastError: null });
    return { result, replayed: false };
  } catch (error) {
    const definite = isDefiniteFailure(error);
    // Unknown: keep in flight; the lease expires and the reconciler GETs first (§10.3.4).
    await settle(
      db,
      spec.key,
      now,
      definite ? { state: "failed", lastError: describe(error) } : { lastError: describe(error) },
    );
    throw definite ? error : new OperationInProgressError(spec.key);
  }
}

/**
 * Marks a succeeded call whose BUSINESS outcome is a refusal (e.g. a capture that came back DECLINED) as
 * failed, so an explicit owner retry may run it again under a new key (SPEC §10.3.1).
 */
export async function markOperationFailed(db: Executor, key: string, reason: string): Promise<void> {
  await db
    .update(paymentOperations)
    .set({ state: "failed", lastError: reason.slice(0, 300), appliedAt: new Date(), updatedAt: new Date() })
    .where(eq(paymentOperations.key, key));
}

/** True while any ledger row of this booking with this key prefix is in flight (SPEC §10.3.5). */
export async function hasOperationInFlight(db: Executor, bookingId: string, keyPrefix: string): Promise<boolean> {
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

async function attemptsOf(db: Executor, baseKey: string) {
  return db
    .select({ key: paymentOperations.key, state: paymentOperations.state })
    .from(paymentOperations)
    .where(sql`${paymentOperations.key} = ${baseKey} or ${paymentOperations.key} like ${`${baseKey}:retry-%`}`);
}

const retryKey = (baseKey: string, n: number) => (n === 0 ? baseKey : `${baseKey}:retry-${n}`);

/** The next retry key after failures: `<base>:retry-<n>` (SPEC §10.3.1). Refuses while one is open. */
export async function nextRetryKey(db: Executor, baseKey: string): Promise<{ key: string; n: number }> {
  const rows = await attemptsOf(db, baseKey);
  if (rows.some((r) => r.state !== "failed")) {
    throw new OperationFailedError(baseKey, "a previous attempt is still running or already succeeded");
  }
  return { key: retryKey(baseKey, rows.length), n: rows.length };
}

/**
 * The key for a step the owner may repeat: the open attempt if there is one (resume or replay),
 * otherwise the next attempt after any failures.
 */
export async function resumableKey(db: Executor, baseKey: string): Promise<{ key: string; n: number }> {
  const rows = await attemptsOf(db, baseKey);
  const open = rows.find((r) => r.state !== "failed");
  if (open) return { key: open.key, n: open.key === baseKey ? 0 : Number(open.key.split(":retry-")[1]) };
  return { key: retryKey(baseKey, rows.length), n: rows.length };
}

/** Succeeded operations the reconciler has not yet confirmed against the domain tables. */
export async function unappliedOperations(db: Db, before: Date, limit: number): Promise<OperationRow[]> {
  return db
    .select()
    .from(paymentOperations)
    .where(
      and(
        eq(paymentOperations.state, "succeeded"),
        sql`${paymentOperations.appliedAt} is null`,
        lt(paymentOperations.updatedAt, before),
      ),
    )
    .orderBy(paymentOperations.updatedAt)
    .limit(limit);
}

export async function markApplied(db: Executor, key: string, at: Date): Promise<void> {
  await db.update(paymentOperations).set({ appliedAt: at }).where(eq(paymentOperations.key, key));
}
