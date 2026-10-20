import { afterEach, describe, expect, it, vi } from "vitest";

import { register } from "@/instrumentation";

const VALID = {
  NEXT_RUNTIME: "nodejs",
  PAYPAL_ENV: "sandbox",
  SESSION_SECRET: "s".repeat(48),
  APP_INSTANCE_ID: "t-unit",
};

function stubAll(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("instrumentation register() — the hard sandbox guard", () => {
  it("exits with code 1 when PAYPAL_ENV is not sandbox", async () => {
    stubAll({ ...VALID, PAYPAL_ENV: "live", NEXT_PHASE: undefined });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await register();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("starts normally with a valid sandbox config", async () => {
    stubAll({ ...VALID, NEXT_PHASE: undefined });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await register();

    expect(exit).not.toHaveBeenCalled();
  });

  it("skips the check during `next build` and on the edge runtime", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    stubAll({ ...VALID, PAYPAL_ENV: "live", NEXT_PHASE: "phase-production-build" });
    await register();
    stubAll({ ...VALID, PAYPAL_ENV: "live", NEXT_PHASE: undefined, NEXT_RUNTIME: "edge" });
    await register();

    expect(exit).not.toHaveBeenCalled();
  });
});
