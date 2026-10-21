import { z } from "zod";

/**
 * Environment handling.
 *
 * - Boot config is validated once at server start (see src/instrumentation.ts);
 *   a failure refuses to start the server. This is the hard sandbox guard.
 * - Integrations are enabled only when ALL of their variables are present and
 *   their secrets are long enough. They are validated lazily, never at import
 *   time, so `next build` cannot fail on missing secrets.
 */

export const MIN_SECRET_LENGTH = 32;

type Env = Record<string, string | undefined>;

/** Treats empty / whitespace-only values as missing. */
export function readVar(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const bootSchema = z.object({
  PAYPAL_ENV: z.literal("sandbox", {
    error: "PAYPAL_ENV must be exactly 'sandbox' (Holdline never talks to live PayPal)",
  }),
  PAYPAL_MODE: z.enum(["live", "mock"]).default("live"),
  SESSION_SECRET: z
    .string({ error: "SESSION_SECRET is required" })
    .min(MIN_SECRET_LENGTH, `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`),
  APP_INSTANCE_ID: z
    .string({ error: "APP_INSTANCE_ID is required" })
    .regex(/^[a-z0-9-]{1,8}$/, "APP_INSTANCE_ID must be 1-8 chars of [a-z0-9-]"),
});

export type BootConfig = z.infer<typeof bootSchema>;

/** Validates the settings without which the server must not run. Throws ConfigError. */
export function loadBootConfig(env: Env = process.env): BootConfig {
  const parsed = bootSchema.safeParse({
    PAYPAL_ENV: readVar(env, "PAYPAL_ENV"),
    PAYPAL_MODE: readVar(env, "PAYPAL_MODE"),
    SESSION_SECRET: readVar(env, "SESSION_SECRET"),
    APP_INSTANCE_ID: readVar(env, "APP_INSTANCE_ID"),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; ");
    throw new ConfigError(`Invalid boot configuration: ${issues}`);
  }
  if (parsed.data.PAYPAL_MODE === "mock" && isOnRender(env)) {
    throw new ConfigError("PAYPAL_MODE=mock is not allowed on Render (judges must hit the real sandbox)");
  }
  return parsed.data;
}

export function isOnRender(env: Env = process.env): boolean {
  return readVar(env, "RENDER") !== undefined;
}

/** Public base URL of the app: APP_URL, then Render's external URL, then localhost. */
export function appUrl(env: Env = process.env): string {
  const url = readVar(env, "APP_URL") ?? readVar(env, "RENDER_EXTERNAL_URL") ?? "http://localhost:3000";
  return url.replace(/\/+$/, "");
}

/**
 * Returns a secret only if it is present and long enough; otherwise undefined.
 * Callers must treat undefined as "feature disabled" — never as "no auth needed".
 */
export function readSecret(env: Env, name: string): string | undefined {
  const value = readVar(env, name);
  return value && value.length >= MIN_SECRET_LENGTH ? value : undefined;
}

type Requirement = { name: string; secret?: boolean };

const INTEGRATIONS = {
  paypal: [{ name: "PAYPAL_CLIENT_ID" }, { name: "PAYPAL_CLIENT_SECRET" }],
  paypalWebhooks: [{ name: "PAYPAL_WEBHOOK_ID" }],
  paypalInvoicing: [{ name: "PAYPAL_BUSINESS_EMAIL" }],
  vapi: [
    { name: "VAPI_PRIVATE_KEY" },
    { name: "VAPI_ASSISTANT_ID" },
    { name: "VAPI_WEBHOOK_SECRET", secret: true },
    { name: "VAPI_LLM_PROVIDER" },
    { name: "VAPI_LLM_MODEL" },
  ],
  gemini: [
    { name: "GEMINI_API_KEY" },
    { name: "GEMINI_CHAT_MODEL" },
    { name: "GEMINI_SUMMARY_MODEL" },
    { name: "GEMINI_DAILY_BUDGET_CENTS" },
  ],
  resend: [{ name: "RESEND_API_KEY" }, { name: "EMAIL_FROM" }],
  // Inbound bounce/complaint webhook (stage 8) — separate so outbound mail doesn't depend on it.
  resendWebhook: [{ name: "RESEND_WEBHOOK_SECRET", secret: true }],
  cron: [{ name: "CRON_SECRET", secret: true }],
  admin: [{ name: "ADMIN_TOKEN", secret: true }],
} satisfies Record<string, Requirement[]>;

export type Integration = keyof typeof INTEGRATIONS;

/** An integration is enabled only if every variable is set and every secret is long enough. */
export function isEnabled(integration: Integration, env: Env = process.env): boolean {
  return INTEGRATIONS[integration].every((req: Requirement) =>
    req.secret ? readSecret(env, req.name) !== undefined : readVar(env, req.name) !== undefined,
  );
}

export function capabilities(env: Env = process.env): Record<Integration, boolean> {
  return Object.fromEntries(
    (Object.keys(INTEGRATIONS) as Integration[]).map((key) => [key, isEnabled(key, env)]),
  ) as Record<Integration, boolean>;
}
