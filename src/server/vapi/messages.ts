import { z } from "zod";

/** Webhook bodies from Vapi are capped before parsing (SPEC §14.5). */
export const MAX_VAPI_BODY_BYTES = 256 * 1024;

const callSchema = z
  .object({
    id: z.string().min(1).max(100),
    type: z.string().max(50).optional(),
    monitor: z
      .object({ controlUrl: z.string().max(2000).optional() })
      .loose()
      .optional(),
  })
  .loose();

/** The envelope every server message shares: `{ message: { type, call, ... } }`. */
const envelopeSchema = z.object({
  message: z
    .object({
      type: z.string().min(1).max(100),
      call: callSchema.optional(),
    })
    .loose(),
});

export type VapiServerMessage = z.infer<typeof envelopeSchema>["message"];

export function parseServerMessage(raw: unknown): VapiServerMessage | null {
  const parsed = envelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data.message : null;
}

const toolCallSchema = z.object({
  id: z.string().min(1).max(200),
  function: z.object({
    name: z.string().min(1).max(100),
    // The generated type says string; deliveries have used objects too. Accept both.
    arguments: z.union([z.string().max(20_000), z.record(z.string(), z.unknown())]).optional(),
  }),
});

export type ToolCall = { id: string; name: string; args: Record<string, unknown> | null };

/** Tool calls from a `tool-calls` message. `args` is null when the arguments aren't a JSON object. */
export function toolCallsOf(message: VapiServerMessage): ToolCall[] {
  const list = z.array(z.unknown()).safeParse(message.toolCallList);
  if (!list.success) return [];
  const calls: ToolCall[] = [];
  for (const item of list.data) {
    const parsed = toolCallSchema.safeParse(item);
    if (parsed.success) {
      const { id, function: fn } = parsed.data;
      calls.push({ id, name: fn.name, args: argsObject(fn.arguments) });
      continue;
    }
    // Every toolCallId needs a result (SPEC §14.5): a malformed entry with a usable id gets one as invalid.
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 200) continue;
    const name = (item as { function?: { name?: unknown } }).function?.name;
    calls.push({ id, name: typeof name === "string" && name ? name.slice(0, 100) : "unknown", args: null });
  }
  return calls;
}

function argsObject(value: string | Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (value === undefined || value === "") return {};
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type ToolResult = { toolCallId: string; name: string; result?: string; error?: string };

const statusSchema = z.object({ status: z.string().max(50), endedReason: z.string().max(200).optional() }).loose();

export function statusOf(message: VapiServerMessage): { status: string; endedReason?: string } | null {
  const parsed = statusSchema.safeParse(message);
  return parsed.success ? { status: parsed.data.status, endedReason: parsed.data.endedReason } : null;
}

const reportSchema = z
  .object({
    endedReason: z.string().max(200).optional(),
    cost: z.number().nonnegative().optional(),
    startedAt: z.string().max(40).optional(),
    endedAt: z.string().max(40).optional(),
    artifact: z
      .object({
        transcript: z.string().optional(),
        messages: z.array(z.unknown()).optional(),
        performanceMetrics: z.record(z.string(), z.unknown()).optional(),
      })
      .loose()
      .optional(),
    assistant: z
      .object({
        model: z
          .object({ model: z.string().max(100).optional() })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export type CallReport = {
  endedReason: string | null;
  costCents: number | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationS: number | null;
  transcript: string | null;
  messages: unknown[] | null;
  metrics: Record<string, unknown> | null;
  llmModel: string | null;
};

export function reportOf(message: VapiServerMessage): CallReport | null {
  const parsed = reportSchema.safeParse(message);
  if (!parsed.success) return null;
  const r = parsed.data;
  const startedAt = toDate(r.startedAt);
  const endedAt = toDate(r.endedAt);
  return {
    endedReason: r.endedReason ?? null,
    costCents: r.cost === undefined ? null : Math.round(r.cost * 100),
    startedAt,
    endedAt,
    durationS: startedAt && endedAt ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : null,
    transcript: r.artifact?.transcript?.slice(0, 100_000) ?? null,
    messages: r.artifact?.messages ?? null,
    metrics: r.artifact?.performanceMetrics ?? null,
    llmModel: r.assistant?.model?.model ?? null,
  };
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * p50/p95 of `turnLatencies[].turnLatency` (ms), the R6 measure. Every TurnLatency field is optional
 * in Vapi's schema, so turns without a number are skipped instead of discarding the whole call.
 */
export function turnLatencyStats(metrics: unknown): { n: number; p50: number; p95: number } | null {
  const turns = z
    .object({ turnLatencies: z.array(z.unknown()) })
    .loose()
    .safeParse(metrics);
  if (!turns.success) return null;
  const sorted = turns.data.turnLatencies
    .map((t) => (t && typeof t === "object" ? (t as { turnLatency?: unknown }).turnLatency : undefined))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { n: sorted.length, p50: Math.round(pick(0.5)), p95: Math.round(pick(0.95)) };
}

const REDACT_KEY = /(url|token|secret|password|authorization)$/i;

/**
 * A copy safe to keep as a test fixture: capability URLs (controlUrl, listenUrl, webCallUrl,
 * recording links) and tokens are replaced, the structure and every other value stay.
 */
export function redactForFixture(value: unknown, depth = 0): unknown {
  if (depth > 40) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redactForFixture(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        REDACT_KEY.test(k) && typeof v === "string" ? "[redacted]" : redactForFixture(v, depth + 1),
      ]),
    );
  }
  return value;
}
