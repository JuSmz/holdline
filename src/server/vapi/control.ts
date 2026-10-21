/**
 * Live call control through `call.monitor.controlUrl` (SPEC §16). The URL arrives from Vapi
 * (create response, webhook or GET /call), so it is checked before we POST to it: https on a
 * vapi.ai host only, which keeps a forged value from turning this into a request forwarder.
 */

const DEFAULT_TIMEOUT_MS = 3_000;

export function isAllowedControlUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  return url.hostname === "vapi.ai" || url.hostname.endsWith(".vapi.ai");
}

export type ControlMessage =
  | {
      type: "say";
      content: string;
      endCallAfterSpoken?: boolean;
      interruptionsEnabled?: boolean;
      interruptAssistantEnabled?: boolean;
    }
  | {
      type: "add-message";
      message: { role: "system" | "assistant" | "user"; content: string };
      triggerResponseEnabled?: boolean;
    }
  | { type: "end-call" };

export type ControlResult = { ok: boolean; status: number | null; ms: number; error?: string };

/** One POST, no retries (a late `say` is worse than none; the email covers the caller). Never throws. */
export async function sendControl(
  controlUrl: string,
  message: ControlMessage,
  options: { timeoutMs?: number; fetch?: typeof globalThis.fetch } = {},
): Promise<ControlResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  if (!isAllowedControlUrl(controlUrl)) return { ok: false, status: null, ms: 0, error: "control_url_not_allowed" };
  try {
    const response = await (options.fetch ?? globalThis.fetch)(controlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return { ok: response.ok, status: response.status, ms: elapsed() };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    return { ok: false, status: null, ms: elapsed(), error: name === "TimeoutError" ? "timeout" : "network" };
  }
}
