import type { Db } from "@/db/types";
import { consume, peek } from "@/server/security/rate-limit";

import {
  GeminiApiError,
  type GeminiClient,
  type GenerateContentRequest,
  type GenerateContentResponse,
  type UsageMetadata,
} from "./client";

/**
 * The global daily Gemini budget (SPEC §22), counted from `usageMetadata` in millicents
 * (1/1000 cent) so small turns add up exactly. Prices per 1M tokens, paid Standard tier, checked
 * 2026-10-22; output includes thinking tokens. An unknown model is charged at the highest rate.
 */

type Rates = { input: number; output: number; cached: number };

const PRICES_USD_PER_M: Record<string, Rates> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 0.03 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cached: 0.025 },
  "gemini-3-flash-preview": { input: 0.5, output: 3.0, cached: 0.05 },
};
const FALLBACK: Rates = { input: 1.5, output: 7.5, cached: 0.15 };
/** The 3.6/3.8 Flash launch prices end on 2026-12-31; from then on they double. */
const LAUNCH_PRICE_END = Date.UTC(2027, 0, 1);

function ratesFor(model: string, now: Date): Rates {
  const rates = PRICES_USD_PER_M[model] ?? FALLBACK;
  const doubled = /^gemini-3\.[68]-flash$/.test(model) && now.getTime() >= LAUNCH_PRICE_END;
  return doubled ? { input: rates.input * 2, output: rates.output * 2, cached: rates.cached * 2 } : rates;
}

/** $X per 1M tokens = X × 0.1 millicents per token. Rounded up per request. */
export function costMillicents(model: string, usage: UsageMetadata | undefined, now: Date): number {
  if (!usage) return 0;
  const r = ratesFor(model, now);
  const prompt = usage.promptTokenCount ?? 0;
  const cached = Math.min(usage.cachedContentTokenCount ?? 0, prompt);
  const toolUse = usage.toolUsePromptTokenCount ?? 0;
  const output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const usd = (prompt - cached) * r.input + cached * r.cached + toolUse * r.input + output * r.output;
  return Math.ceil(usd * 0.1);
}

export class GeminiBudgetError extends Error {
  constructor() {
    super("The demo budget for today is reached.");
    this.name = "GeminiBudgetError";
  }
}

const SCOPE = "gemini_spend";
/** Reserved before each request so parallel chats can't all pass a stale check (≈ one large turn). */
const RESERVE = 2_000;

/** Reserves room for one request, or throws GeminiBudgetError. An unsettled reservation stays counted. */
export async function reserveBudget(db: Db, limitCents: number, now: Date): Promise<void> {
  const limit = limitCents * 1000;
  const held = await consume(db, { scope: SCOPE, key: "global", window: "day", limit, now, amount: RESERVE });
  if (!held.ok) {
    await consume(db, { scope: SCOPE, key: "global", window: "day", limit, now, amount: -RESERVE });
    throw new GeminiBudgetError();
  }
}

/** Replaces the reservation with the request's real cost. */
export async function settleBudget(db: Db, limitCents: number, cost: number, now: Date): Promise<void> {
  await consume(db, {
    scope: SCOPE,
    key: "global",
    window: "day",
    limit: limitCents * 1000,
    now,
    amount: cost - RESERVE,
  });
}

export async function spentTodayMillicents(db: Db, now: Date): Promise<number> {
  return peek(db, { scope: SCOPE, key: "global", window: "day", now });
}

/**
 * One budgeted generateContent call: reserve, call, settle with the cost from usageMetadata. A refused
 * request (4xx) isn't billed and is refunded; a timeout or network error keeps the reservation.
 */
export async function budgetedGenerate(
  input: { db: Db; client: GeminiClient; model: string; limitCents: number; now: () => Date },
  body: GenerateContentRequest,
): Promise<GenerateContentResponse> {
  // One timestamp for reserve and settle: a request across UTC midnight settles into its own day.
  const at = input.now();
  await reserveBudget(input.db, input.limitCents, at);
  let response: GenerateContentResponse;
  try {
    response = await input.client.generateContent(input.model, body);
  } catch (error) {
    if (error instanceof GeminiApiError && error.status < 500) await settleBudget(input.db, input.limitCents, 0, at);
    throw error;
  }
  await settleBudget(input.db, input.limitCents, costMillicents(input.model, response.usageMetadata, input.now()), at);
  return response;
}
