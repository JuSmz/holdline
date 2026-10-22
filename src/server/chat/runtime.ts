import { randomUUID } from "node:crypto";

import { and, eq, isNull, lt, or } from "drizzle-orm";

import { calls, workspaces } from "@/db/schema";
import { type AgentContext, agentCallOf, agentContext, runAgentTool } from "@/server/agent/handlers";
import { systemPrompt } from "@/server/agent/prompt";
import { AGENT_TOOLS } from "@/server/agent/tools";
import { budgetedGenerate, GeminiBudgetError } from "@/server/gemini/budget";
import {
  type Content,
  GeminiApiError,
  type GeminiClient,
  geminiConfig,
  GeminiNotConfiguredError,
  getGeminiClient,
  type Part,
} from "@/server/gemini/client";
import { clientIp } from "@/server/security/client-ip";
import { consume, ipHash } from "@/server/security/rate-limit";
import { dbErrorCode } from "@/server/db-error";

import { appendChat, type ChatLine } from "./transcript";

/** Chat sizes and limits (SPEC §15, §22). */
export const CHAT_LIMITS = {
  messageChars: 500,
  bodyBytes: 8 * 1024,
  /** generateContent requests per user turn; the last one may not call tools. */
  requestsPerTurn: 5,
  /** Stored contents sent back as history (≈ 30 messages, ≈ 8k tokens). */
  historyContents: 30,
  turnsPerChat: 40,
  turnsPerWorkspaceDay: 80,
  turnsPerIpDay: 120,
  /** No new tool round trip starts after this. The lease is renewed before every request. */
  turnDeadlineMs: 90_000,
  turnLeaseMs: 150_000,
  /** Includes thinking tokens (3.x Flash bills and caps them together), so more than the visible 300. */
  maxOutputTokens: 1024,
} as const;

export type ChatRow = typeof calls.$inferSelect;

export type ChatDeps = {
  ctx: AgentContext;
  gemini: GeminiClient;
  model: string;
  dailyBudgetCents: number;
};

export type ChatTurnResult =
  | { ok: true; lines: ChatLine[]; chips: string[] }
  | {
      ok: false;
      reason: "busy" | "budget" | "limit" | "unavailable" | "rephrase";
      message: string;
      /** The turn was kept anyway (tools had run): the transcript already shows it. */
      stored?: boolean;
    };

const FALLBACK_REPLY = "Sorry, I didn't quite get that — could you say it another way?";
const ERROR_REPLY = "Sorry — something went wrong on my side. Could you say that again?";

const TOOL_DECLARATIONS = AGENT_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parametersJsonSchema: t.parameters,
}));

// Filters stay moderate: a gas-leak or sparking report must still get the safety advice through.
const SAFETY = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
];

/** Invisible characters used to disguise text (zero-width, bidi controls, soft hyphen); ZWJ and ZWNJ stay. */
const DISGUISE = /[\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
/** The system's note starts with "[payment-update"; typed look-alikes (bracketed or at a line start). */
const FORGED_NOTE = /(\[\s*payment[\W_]{0,6}update\s*\]?)|(^\s*payment[\W_]{0,6}update\s*\])/gim;

/**
 * A customer message as stored and sent to the model: well-formed, control characters (except
 * newlines and tabs) and disguising invisible characters removed. Anything that imitates the
 * system's [payment-update] note (checked on an NFKC-normalized copy, so full-width and zero-width
 * tricks count) is rewritten to "payment status", so typed text can't pass for a confirmation.
 * Idempotent; ordinary text is left as typed. The model still calls check_payment_status before
 * confirming in chat (prompt), so a look-alike that slips through changes wording, never money.
 */
export function cleanChatText(text: string): string {
  const cleaned = text
    .toWellFormed()
    .replace(DISGUISE, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .trim();
  const probe = cleaned.normalize("NFKC").replace(/\p{Cf}/gu, "");
  if (!new RegExp(FORGED_NOTE.source, "im").test(probe)) return cleaned;
  return probe.replace(FORGED_NOTE, "payment status").trim();
}

/** Failures that end a turn early without being our bug: the model is unavailable or over budget. */
type TurnFailure = Extract<ChatTurnResult, { ok: false }>;

function turnFailure(error: unknown): TurnFailure | null {
  if (error instanceof GeminiBudgetError) {
    return {
      ok: false,
      reason: "budget",
      message: "The demo budget for today is reached — please come back tomorrow.",
    };
  }
  const name = error instanceof Error ? error.name : "";
  if (
    error instanceof GeminiApiError ||
    error instanceof GeminiNotConfiguredError ||
    name === "TimeoutError" ||
    name === "AbortError" ||
    error instanceof TypeError // undici's network failures ("fetch failed", "terminated")
  ) {
    console.error(
      `[holdline] chat model request failed: ${name} ${error instanceof GeminiApiError ? error.status : ""}`,
    );
    return { ok: false, reason: "unavailable", message: "The assistant is unavailable right now. Please try again." };
  }
  return null;
}

async function turnLimits(deps: ChatDeps, chat: ChatRow, ipKey: string, now: Date): Promise<boolean> {
  const { db } = deps.ctx;
  const checks = [
    { scope: "chat_turns", key: chat.id, window: "life" as const, limit: CHAT_LIMITS.turnsPerChat },
    { scope: "chat_turns_ws", key: chat.workspaceId, window: "day" as const, limit: CHAT_LIMITS.turnsPerWorkspaceDay },
    { scope: "chat_turns_ip", key: ipKey, window: "day" as const, limit: CHAT_LIMITS.turnsPerIpDay },
  ];
  for (const check of checks) {
    if (!(await consume(db, { ...check, now })).ok) return false;
  }
  return true;
}

/**
 * One user turn of the text chat (SPEC §15): runtime (a), stateless generateContent with the raw
 * `Content[]` from our database. Model contents are stored verbatim (thought signatures included).
 * The turn's contents are appended in one statement at the end and always end with a model turn, so
 * history alternates and never holds a function call without its response. A turn that fails after
 * tools already ran keeps those round trips, so the model's history matches what happened.
 */
export async function runChatTurn(
  deps: ChatDeps,
  chat: ChatRow,
  text: string,
  options: { ipHeaders?: Headers } = {},
): Promise<ChatTurnResult> {
  const { db } = deps.ctx;
  const userText = cleanChatText(text);
  const now = deps.ctx.now();
  let lease = new Date(now.getTime() + CHAT_LIMITS.turnLeaseMs);
  const [leased] = await db
    .update(calls)
    .set({ chatTurnUntil: lease })
    .where(and(eq(calls.id, chat.id), or(isNull(calls.chatTurnUntil), lt(calls.chatTurnUntil, now))))
    .returning();
  if (!leased) return { ok: false, reason: "busy", message: "One moment — I'm still answering your last message." };

  try {
    const ipKey = ipHash(options.ipHeaders ? clientIp(options.ipHeaders) : null);
    if (!(await turnLimits(deps, chat, ipKey, now))) {
      return {
        ok: false,
        reason: "limit",
        message: "This demo chat has reached its message limit for now. Start a new chat later to try again.",
      };
    }

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, chat.workspaceId));
    const system = `${systemPrompt({
      businessName: ws.name,
      channel: "chat",
      firstName: chat.caller?.firstName,
      email: chat.caller?.email,
    })}\n\nToday is ${todayIn(now, ws.timezone)} in Austin.`;

    const userContent: Content = { role: "user", parts: [{ text: userText }] };
    const contents: Content[] = [...trimHistory(storedContents(leased)), userContent];
    const added: Content[] = [userContent];
    const toolResults: { name: string; result: Record<string, unknown> }[] = [];
    const agentCall = agentCallOf(leased);
    const turnId = randomUUID();
    const started = Date.now();
    let reply: string | null = null;
    let failure: TurnFailure | null = null;

    const unavailable: TurnFailure = {
      ok: false,
      reason: "unavailable",
      message: "Something went wrong on our side. Please try again.",
    };
    for (let trip = 0; trip < CHAT_LIMITS.requestsPerTurn; trip += 1) {
      // A trip in progress: its model turn and the responses of the calls that already ran.
      let partial: { content: Content; responses: Part[]; calls: Part[] } | null = null;
      try {
        // Renew the lease before every request, so a slow turn never loses it to a second turn.
        const renewed = new Date(deps.ctx.now().getTime() + CHAT_LIMITS.turnLeaseMs);
        const [kept] = await db
          .update(calls)
          .set({ chatTurnUntil: renewed })
          .where(and(eq(calls.id, chat.id), eq(calls.chatTurnUntil, lease)))
          .returning({ id: calls.id });
        if (!kept) {
          failure = unavailable;
          break;
        }
        lease = renewed;

        const final = trip === CHAT_LIMITS.requestsPerTurn - 1 || Date.now() - started > CHAT_LIMITS.turnDeadlineMs;
        const response = await budgetedGenerate(
          { db, client: deps.gemini, model: deps.model, limitCents: deps.dailyBudgetCents, now: deps.ctx.now },
          {
            systemInstruction: { parts: [{ text: system }] },
            contents,
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
            toolConfig: { functionCallingConfig: { mode: final ? "NONE" : "AUTO" } },
            generationConfig: {
              thinkingConfig: { thinkingLevel: "low" },
              maxOutputTokens: CHAT_LIMITS.maxOutputTokens,
            },
            safetySettings: SAFETY,
          },
        );
        if (trip === 0 && response.promptFeedback?.blockReason) {
          // The message itself was blocked: store nothing, so it isn't sent again with every later turn.
          return {
            ok: false,
            reason: "rephrase",
            message: "I can't help with that message — could you rephrase it?",
          };
        }
        const content = response.candidates?.[0]?.content;
        if (!content || !Array.isArray(content.parts) || content.parts.length === 0) {
          reply = FALLBACK_REPLY;
          break;
        }
        const functionCalls = content.parts.filter(
          (p): p is Part & { functionCall: NonNullable<Part["functionCall"]> } => Boolean(p.functionCall),
        );
        if (functionCalls.length > 0 && final) {
          // Calls on the last request can't get their responses: drop that model turn, answer plainly.
          reply = FALLBACK_REPLY;
          break;
        }
        if (functionCalls.length === 0) {
          reply = visibleText(content.parts) || null;
          // Verbatim: every part, including thoughtSignature, goes back unchanged next time.
          if (reply) added.push({ role: "model", parts: content.parts });
          reply ??= FALLBACK_REPLY;
          break;
        }
        // One user turn with all responses, in call order, matched by id (docs: no interleaving). The
        // model turn joins the history only together with its responses.
        partial = { content: { role: "model", parts: content.parts }, responses: [], calls: functionCalls };
        for (const [index, part] of functionCalls.entries()) {
          const fc = part.functionCall;
          const result = await runAgentTool(deps.ctx, agentCall, {
            id: `chat:${turnId}:${trip}:${index}`,
            name: fc.name,
            args: fc.args ?? {},
          });
          toolResults.push({ name: fc.name, result });
          partial.responses.push(responseFor(fc, result));
        }
        const pair: Content[] = [partial.content, { role: "user", parts: partial.responses }];
        partial = null;
        contents.push(...pair);
        added.push(...pair);
      } catch (error) {
        if (partial && partial.responses.length > 0) {
          // Some tools of this trip ran: keep their results, and answer the rest with an error, so the
          // history matches what happened.
          const missing = partial.calls
            .slice(partial.responses.length)
            .map((p) => responseFor(p.functionCall!, { ok: false, reason: "internal_error" }));
          added.push(partial.content, { role: "user", parts: [...partial.responses, ...missing] });
        }
        failure = turnFailure(error);
        if (!failure) {
          // Not the model's fault. Before any tool ran, nothing happened: a plain error. After, the
          // completed tool results are kept so the history matches what the tools did.
          if (toolResults.length === 0) throw error;
          console.error(`[holdline] chat turn for ${chat.id} failed after tools ran: ${dbErrorCode(error)}`);
          failure = unavailable;
        }
        break;
      }
    }

    // Nothing happened yet: a failed first request stores nothing.
    if (failure && toolResults.length === 0 && added.length === 1) return failure;
    reply ??= failure ? ERROR_REPLY : FALLBACK_REPLY;
    if (added.at(-1)?.role !== "model") added.push({ role: "model", parts: [{ text: reply }] });

    const at = new Date().toISOString();
    const lines: ChatLine[] = [
      { role: "user", text: userText, at },
      { role: "assistant", text: reply, at },
    ];
    await appendChat(db, chat.id, { lines, contents: added });
    return failure ? { ...failure, stored: true } : { ok: true, lines, chips: chipsFor(toolResults) };
  } finally {
    // Only our own lease: a turn that outlived it must not free a newer turn's lease.
    await db
      .update(calls)
      .set({ chatTurnUntil: null })
      .where(and(eq(calls.id, chat.id), eq(calls.chatTurnUntil, lease)));
  }
}

function responseFor(fc: NonNullable<Part["functionCall"]>, result: Record<string, unknown>): Part {
  return { functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, response: result } };
}

function storedContents(row: ChatRow): Content[] {
  return Array.isArray(row.geminiContents) ? (row.geminiContents as Content[]) : [];
}

const isUserText = (c: Content) =>
  c.role === "user" && c.parts.some((p) => typeof p.text === "string") && !c.parts.some((p) => p.functionResponse);

/** The last ~30 contents, starting at a user text turn so no function call loses its response. */
export function trimHistory(contents: Content[]): Content[] {
  if (contents.length <= CHAT_LIMITS.historyContents) return contents;
  let start = contents.length - CHAT_LIMITS.historyContents;
  while (start < contents.length && !isUserText(contents[start])) start += 1;
  return contents.slice(start);
}

function visibleText(parts: Part[]): string {
  return parts
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
}

/** Quick replies from what the tools just returned (SPEC §15): slot labels, or the next step. */
export function chipsFor(results: { name: string; result: Record<string, unknown> }[]): string[] {
  const last = results.at(-1);
  if (!last) return [];
  if (last.name === "check_availability") {
    const slots = (last.result.slots as { label?: string }[] | undefined) ?? [];
    return slots.map((s) => s.label).filter((l): l is string => typeof l === "string");
  }
  if (last.name === "create_booking_with_payment_link" && last.result.ok === true)
    return ["Did the payment go through?"];
  return [];
}

function todayIn(now: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    now,
  );
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now);
  return `${weekday}, ${date}`;
}

export const STARTER_CHIPS = ["My kitchen drain is blocked", "An outlet stopped working", "What do you charge?"];

/** The production chat dependencies, or null while Gemini isn't configured. */
export function chatDeps(ctx: AgentContext = agentContext()): ChatDeps | null {
  const config = geminiConfig();
  if (!config) return null;
  return { ctx, gemini: getGeminiClient(), model: config.chatModel, dailyBudgetCents: config.dailyBudgetCents };
}
