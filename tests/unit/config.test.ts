import { describe, expect, it } from "vitest";

import { appUrl, capabilities, ConfigError, isEnabled, loadBootConfig, readSecret } from "@/server/config/env";

const SECRET = "x".repeat(32);
const BASE = { PAYPAL_ENV: "sandbox", SESSION_SECRET: SECRET, APP_INSTANCE_ID: "dj" };

describe("loadBootConfig (sandbox guard)", () => {
  it("accepts a valid sandbox config and defaults PAYPAL_MODE to live", () => {
    expect(loadBootConfig(BASE)).toEqual({ ...BASE, PAYPAL_MODE: "live" });
  });

  it.each([undefined, "", "live", "production", "Sandbox"])("refuses PAYPAL_ENV=%s", (value) => {
    expect(() => loadBootConfig({ ...BASE, PAYPAL_ENV: value })).toThrow(ConfigError);
  });

  it("refuses a missing or short SESSION_SECRET", () => {
    expect(() => loadBootConfig({ ...BASE, SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET/);
    expect(() => loadBootConfig({ ...BASE, SESSION_SECRET: "short" })).toThrow(/at least 32/);
  });

  it("refuses an invalid APP_INSTANCE_ID", () => {
    expect(() => loadBootConfig({ ...BASE, APP_INSTANCE_ID: "Prod_1" })).toThrow(/APP_INSTANCE_ID/);
    expect(() => loadBootConfig({ ...BASE, APP_INSTANCE_ID: undefined })).toThrow(/APP_INSTANCE_ID/);
  });

  it("allows mock mode locally but refuses it on Render", () => {
    expect(loadBootConfig({ ...BASE, PAYPAL_MODE: "mock" }).PAYPAL_MODE).toBe("mock");
    expect(() => loadBootConfig({ ...BASE, PAYPAL_MODE: "mock", RENDER: "true" })).toThrow(/not allowed on Render/);
  });
});

describe("integrations", () => {
  it("are disabled unless every variable is present", () => {
    expect(isEnabled("paypal", { PAYPAL_CLIENT_ID: "id" })).toBe(false);
    expect(isEnabled("paypal", { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" })).toBe(true);
    expect(isEnabled("paypalWebhooks", { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" })).toBe(false);
    expect(isEnabled("paypalWebhooks", { PAYPAL_WEBHOOK_ID: "1JE4291016473214C" })).toBe(true);
  });

  it("treat short or blank secrets as missing", () => {
    expect(isEnabled("cron", { CRON_SECRET: "too-short" })).toBe(false);
    expect(isEnabled("cron", { CRON_SECRET: "   " })).toBe(false);
    expect(isEnabled("cron", { CRON_SECRET: SECRET })).toBe(true);
    expect(readSecret({ CRON_SECRET: "" }, "CRON_SECRET")).toBeUndefined();
  });

  it("keeps the inbound Resend webhook separate and length-checked", () => {
    expect(isEnabled("resendWebhook", { RESEND_WEBHOOK_SECRET: "whsec_short" })).toBe(false);
    expect(isEnabled("resendWebhook", { RESEND_WEBHOOK_SECRET: `whsec_${"a".repeat(32)}` })).toBe(true);
    expect(isEnabled("resend", { RESEND_API_KEY: "re_key", EMAIL_FROM: "Holdline <b@mail.example.com>" })).toBe(true);
  });

  it("names the offending variable in boot errors", () => {
    expect(() => loadBootConfig({ ...BASE, PAYPAL_MODE: "Live" })).toThrow(/PAYPAL_MODE:/);
  });

  it("reports every integration as disabled for an empty environment", () => {
    expect(Object.values(capabilities({})).every((enabled) => !enabled)).toBe(true);
  });
});

describe("appUrl", () => {
  it("prefers APP_URL, then Render's external URL, then localhost, without a trailing slash", () => {
    expect(appUrl({ APP_URL: "https://holdline.example/", RENDER_EXTERNAL_URL: "https://x.onrender.com" })).toBe(
      "https://holdline.example",
    );
    expect(appUrl({ RENDER_EXTERNAL_URL: "https://x.onrender.com" })).toBe("https://x.onrender.com");
    expect(appUrl({})).toBe("http://localhost:3000");
  });
});
