import { defineConfig } from "@playwright/test";

const PORT = 3100;
const E2E_DATABASE_URL = process.env.DATABASE_URL_E2E ?? "postgres://postgres@localhost:55433/holdline_e2e";

/**
 * The chat happy path in mock mode (PLAN stage 7): fake PayPal and fake Gemini inside a real Next
 * server on its own database. No paid API is called. Uses the installed Chrome (no browser download).
 * Stop a running `pnpm dev` first: both use .next.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec tsx tests/e2e/setup-db.ts && pnpm exec next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      PAYPAL_ENV: "sandbox",
      PAYPAL_MODE: "mock",
      GEMINI_MODE: "mock",
      APP_URL: `http://localhost:${PORT}`,
      APP_INSTANCE_ID: "e2e",
      SESSION_SECRET: "e2e-session-secret-0123456789-abcdefghij",
      LAB_ENABLED: "false",
      SANDBOX_BUYERS: JSON.stringify([{ email: "buyer-e2e@personal.example.com", password: "sandbox-only" }]),
      // Keep real keys from .env out of this run.
      GEMINI_API_KEY: "",
      VAPI_PRIVATE_KEY: "",
      VAPI_PUBLIC_KEY: "",
      RESEND_API_KEY: "",
    },
  },
});
