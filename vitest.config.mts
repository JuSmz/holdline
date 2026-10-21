import path from "node:path";

import { defineConfig } from "vitest/config";

// Default: Holdline's own local Postgres (scripts/local-db.sh). CI sets DATABASE_URL_TEST.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? "postgres://postgres@localhost:55433/holdline_test";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // `server-only` throws outside React Server Components; tests run in plain Node.
      "server-only": path.resolve(import.meta.dirname, "tests/support/empty-module.ts"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/integration/global-setup.ts"],
          // One shared Postgres: run files one after another; each test owns its data.
          fileParallelism: false,
          env: {
            DATABASE_URL: TEST_DATABASE_URL,
            PAYPAL_ENV: "sandbox",
            APP_INSTANCE_ID: "t-int",
            // Test-only value; the boot config and token signing need ≥ 32 characters.
            SESSION_SECRET: "integration-test-session-secret-0123456789",
          },
        },
      },
    ],
  },
});
