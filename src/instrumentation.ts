/**
 * Runs once when a Next.js server starts, before it serves requests.
 * The boot guard (sandbox-only, required secrets) lives in a Node-only module.
 */
export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { enforceBootConfig } = await import("@/server/boot-guard");
    enforceBootConfig();
  }
}
