/**
 * Vehicle identification numbers (VINs): 17 letters and digits, never I, O or Q. North American VINs carry a check
 * digit (9th place); others (most European ones) needn't, so a VIN someone typed into a Vehicles field is taken as long
 * as it looks like one, but a serial number is only read as a VIN when its check digit is right.
 */

const VIN_SHAPE = /^[A-HJ-NPR-Z0-9]{17}$/;
const VALUES: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Upper case, without spaces or dashes: what a VIN is stored and compared as. */
export function normaliseVin(raw: string) {
  return raw.toUpperCase().replace(/[\s-]+/g, "");
}

/** 17 VIN characters (no I, O, Q). */
export function looksLikeVin(raw: string) {
  return VIN_SHAPE.test(normaliseVin(raw));
}

/** Its 9th character is the check digit the other sixteen give. */
export function vinCheckDigitOk(raw: string) {
  const vin = normaliseVin(raw);
  if (!VIN_SHAPE.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i]!;
    sum += (/\d/.test(c) ? Number(c) : VALUES[c]!) * WEIGHTS[i]!;
  }
  const check = sum % 11;
  return vin[8] === (check === 10 ? "X" : String(check));
}

/**
 * An item's VIN: its Vehicles category's "vin" field when that looks like one, else its serial number when that is
 * unmistakably a VIN (check digit right). Null when it has neither.
 */
export function vinOf(thing: { customFields?: Record<string, unknown> | null; serialNumber?: string | null }) {
  const field = thing.customFields?.vin;
  if (typeof field === "string" && looksLikeVin(field)) return normaliseVin(field);
  if (thing.serialNumber && vinCheckDigitOk(thing.serialNumber)) return normaliseVin(thing.serialNumber);
  return null;
}
