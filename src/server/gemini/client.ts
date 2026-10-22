import { readVar } from "@/server/config/env";

import { fakeGemini } from "./mock/fake-gemini";

/**
 * The Gemini Developer API over REST, stateless `generateContent` (SPEC §15, runtime decision (a)):
 * our database keeps the raw `Content[]`, so conversation data stays with us and every part, including
 * `thoughtSignature`, goes back unchanged. Docs checked 2026-10-22 (docs/gemini-notes.md).
 */

export type Part = Record<string, unknown> & {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
};
export type Content = { role: "user" | "model"; parts: Part[] };

export type UsageMetadata = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
};

export type GenerateContentResponse = {
  candidates?: { content?: Content; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: UsageMetadata;
  modelVersion?: string;
};

export type GenerateContentRequest = {
  systemInstruction?: { parts: { text: string }[] };
  contents: Content[];
  tools?: { functionDeclarations: Record<string, unknown>[] }[];
  toolConfig?: Record<string, unknown>;
  generationConfig?: Record<string, unknown>;
  safetySettings?: { category: string; threshold: string }[];
};

export class GeminiNotConfiguredError extends Error {
  constructor() {
    super("Gemini is not configured (GEMINI_API_KEY and models).");
    this.name = "GeminiNotConfiguredError";
  }
}

export class GeminiApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Gemini API ${status}: ${detail}`);
    this.name = "GeminiApiError";
  }
}

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 20_000;
/** No generation happened on these, so one retry can't be billed twice. */
const RETRYABLE = new Set([429, 500, 503]);

export class GeminiClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly options: {
      apiKey: string;
      fetch?: typeof globalThis.fetch;
      sleep?: (ms: number) => Promise<void>;
      baseUrl?: string;
    },
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async generateContent(model: string, body: GenerateContentRequest): Promise<GenerateContentResponse> {
    if (!/^[a-z0-9.-]{3,60}$/.test(model)) throw new Error(`invalid Gemini model id: ${model}`);
    const url = `${this.options.baseUrl ?? BASE_URL}/models/${model}:generateContent`;
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.options.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return (await response.json()) as GenerateContentResponse;
      const text = await response.text().catch(() => "");
      if (attempt === 0 && RETRYABLE.has(response.status)) {
        await this.sleep(800);
        continue;
      }
      // The key never appears in Google's error bodies; keep only the message.
      const detail = (() => {
        try {
          return String((JSON.parse(text) as { error?: { message?: string } }).error?.message ?? "").slice(0, 300);
        } catch {
          return text.slice(0, 300);
        }
      })();
      throw new GeminiApiError(response.status, detail);
    }
  }
}

export type GeminiConfig = { apiKey: string; chatModel: string; summaryModel: string; dailyBudgetCents: number };

/** GEMINI_MODE=mock: the scripted fake (local and e2e only; the boot config refuses it on Render). */
export function geminiMocked(env: Record<string, string | undefined> = process.env): boolean {
  return readVar(env, "GEMINI_MODE") === "mock";
}

export function geminiConfig(env: Record<string, string | undefined> = process.env): GeminiConfig | null {
  if (geminiMocked(env)) {
    return { apiKey: "mock", chatModel: "gemini-mock", summaryModel: "gemini-mock", dailyBudgetCents: 100 };
  }
  const apiKey = readVar(env, "GEMINI_API_KEY");
  const chatModel = readVar(env, "GEMINI_CHAT_MODEL");
  const summaryModel = readVar(env, "GEMINI_SUMMARY_MODEL");
  const budget = Number(readVar(env, "GEMINI_DAILY_BUDGET_CENTS"));
  if (!apiKey || !chatModel || !summaryModel || !Number.isInteger(budget) || budget <= 0) return null;
  return { apiKey, chatModel, summaryModel, dailyBudgetCents: budget };
}

let override: GeminiClient | null = null;

/** Tests install a client on their own fake here. */
export function setGeminiClientForTests(client: GeminiClient | null): void {
  override = client;
}

export function getGeminiClient(env: Record<string, string | undefined> = process.env): GeminiClient {
  if (override) return override;
  if (geminiMocked(env)) return new GeminiClient({ apiKey: "mock", fetch: fakeGemini().fetch, sleep: async () => {} });
  const config = geminiConfig(env);
  if (!config) throw new GeminiNotConfiguredError();
  return new GeminiClient({ apiKey: config.apiKey });
}
