import { ConfigError, loadBootConfig } from "@/server/config/env";

/**
 * Node-runtime-only boot check (imported from src/instrumentation.ts).
 * Refuses to start on an invalid boot configuration — most importantly, anything
 * other than PAYPAL_ENV=sandbox (SPEC §5). Exits instead of hanging, so a bad
 * deploy fails fast on Render.
 */
export function enforceBootConfig(): void {
  try {
    loadBootConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`[holdline] ${error.message}. Refusing to start.`);
    process.exit(1);
  }
}
