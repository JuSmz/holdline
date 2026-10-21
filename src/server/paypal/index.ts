import { loadBootConfig, readVar } from "@/server/config/env";

import { PayPalClient } from "./client";
import { dbApiLogger } from "./log";

let cached: { key: string; client: PayPalClient } | undefined;

export class PayPalNotConfiguredError extends Error {
  constructor() {
    super("PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing)");
    this.name = "PayPalNotConfiguredError";
  }
}

export function labEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return readVar(env, "LAB_ENABLED") === "true";
}

/** The process-wide sandbox client. Re-checks the boot config so it can never run against anything but sandbox. */
export function getPayPalClient(): PayPalClient {
  const boot = loadBootConfig();
  const clientId = readVar(process.env, "PAYPAL_CLIENT_ID");
  const clientSecret = readVar(process.env, "PAYPAL_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new PayPalNotConfiguredError();

  const key = `${boot.APP_INSTANCE_ID}:${clientId}`;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      client: new PayPalClient({
        clientId,
        clientSecret,
        instanceId: boot.APP_INSTANCE_ID,
        log: dbApiLogger,
        allowMockResponses: labEnabled(),
      }),
    };
  }
  return cached.client;
}
