import type { z } from "zod";

import { readBodyLimited } from "@/server/paypal/webhooks";

/**
 * Reads a JSON body of at most `maxBytes` and validates it (SPEC §20: limits checked before parsing).
 * Returns the parsed value, or the 413/400 response to send.
 */
export async function readJsonLimited<T extends z.ZodType>(
  request: Request,
  maxBytes: number,
  schema: T,
): Promise<z.infer<T> | Response> {
  const bytes = await readBodyLimited(request, maxBytes);
  if (!bytes) return Response.json({ ok: false, error: "too_large" }, { status: 413 });
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return Response.json({ ok: false, error: "invalid_input" }, { status: 400 });
  return parsed.data;
}
