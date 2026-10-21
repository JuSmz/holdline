const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** PayPal honors an authorization for 3 days after creation (SPEC §12). */
export function honorUntil(authorizationCreatedAt: Date): Date {
  return new Date(authorizationCreatedAt.getTime() + 3 * DAY);
}

/**
 * When to reauthorize (SPEC §12, job 4): only when `slot_end + 24 h` lies past the honor period.
 * Then `max(authorized_at + 3 d + 1 h, slot_end − 24 h)`, never later than `authorized_at + 28 d`.
 * Returns null when the original authorization covers the job.
 */
export function reauthorizeAt(input: { authorizedAt: Date; honorUntil: Date; slotEnd: Date }): Date | null {
  if (input.slotEnd.getTime() + DAY <= input.honorUntil.getTime()) return null;
  const earliest = input.authorizedAt.getTime() + 3 * DAY + HOUR;
  const wanted = Math.max(earliest, input.slotEnd.getTime() - DAY);
  return new Date(Math.min(wanted, input.authorizedAt.getTime() + 28 * DAY));
}
