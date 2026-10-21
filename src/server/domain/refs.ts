import { randomInt } from "node:crypto";

/** Crockford base32: no I, L, O, U, so refs read well over the phone. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A booking ref such as `HL-7K3Q9` (SPEC §10.4). Unique by index; the caller retries on collision. */
export function newBookingRef(): string {
  let ref = "HL-";
  for (let i = 0; i < 5; i += 1) ref += CROCKFORD[randomInt(CROCKFORD.length)];
  return ref;
}

export const BOOKING_REF = /^HL-[0-9A-HJKMNP-TV-Z]{5}$/;
