/**
 * A log-safe description of a database error. Drizzle's message embeds the query and its params
 * (payloads, transcripts, controlUrls), so only the error name and the driver's code are logged (SPEC §21).
 */
export function dbErrorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  const name = error instanceof Error ? error.name : typeof error;
  return code ? `${name} ${code}` : name;
}
