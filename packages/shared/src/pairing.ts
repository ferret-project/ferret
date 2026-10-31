/**
 * Smart-home pairing codes: HomeKit (X-HM://…, or the 8-digit XXX-XX-XXX code) and Matter (MT:…, or the 11/21-digit
 * manual code). Decoding only — pure, no dependencies, so the server and the web app share it.
 *
 * HomeKit: "X-HM://" + 9 base-36 characters + a 4-character setup ID. The 9 characters are one number:
 *   bits 0–26 setup code · 27–30 flags · 31–38 category · 39–42 reserved · 43–45 version.
 * Matter (Core spec 5.1.3): "MT:" + base-38 bytes (5 characters → 3 bytes, 4 → 2, 2 → 1, little-endian), read LSB
 * first: version 3 · vendor id 16 · product id 16 · commissioning flow 2 · discovery 8 · discriminator 12 ·
 * passcode 27 · padding 4. Its manual code is derived from the passcode and the discriminator's top 4 bits, with a
 * Verhoeff check digit.
 */

export type PairingKind = "homekit" | "matter";

export interface PairingInfo {
  kind: PairingKind;
  /** The QR code's text (X-HM://… / MT:…), when known: shown as a QR again, for the Home app to scan. */
  payload: string | null;
  /** The code people type: 123-45-678 (HomeKit), 3497-011-2332 (Matter). */
  code: string;
  /** What it is, when the code says (HomeKit's category). */
  category: string | null;
  /** Everything else the code carries, for the curious (setup ID, vendor/product id, discriminator…). */
  details: Record<string, string | number>;
}

/** HomeKit accessory categories (HAP specification). */
const HOMEKIT_CATEGORIES: Record<number, string> = {
  1: "Other",
  2: "Bridge",
  3: "Fan",
  4: "Garage door opener",
  5: "Lightbulb",
  6: "Door lock",
  7: "Outlet",
  8: "Switch",
  9: "Thermostat",
  10: "Sensor",
  11: "Security system",
  12: "Door",
  13: "Window",
  14: "Window covering",
  15: "Programmable switch",
  16: "Range extender",
  17: "IP camera",
  18: "Video doorbell",
  19: "Air purifier",
  20: "Heater",
  21: "Air conditioner",
  22: "Humidifier",
  23: "Dehumidifier",
  28: "Sprinkler",
  29: "Faucet",
  30: "Shower system",
  31: "Television",
  32: "Remote control",
  33: "Router",
};

/** A QR code that is a pairing code (never to be treated as a barcode, or sent anywhere to be looked up). */
export const isPairingPayload = (raw: string) => /^\s*(X-HM:\/\/|MT:)/i.test(raw);

const B38 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-.";

function base38(text: string): Uint8Array | null {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 5) {
    const chunk = text.slice(i, i + 5);
    const bytes = { 5: 3, 4: 2, 2: 1 }[chunk.length as 5 | 4 | 2];
    if (!bytes) return null;
    let value = 0;
    for (let j = chunk.length - 1; j >= 0; j--) {
      const digit = B38.indexOf(chunk[j]!);
      if (digit < 0) return null;
      value = value * 38 + digit;
    }
    for (let b = 0; b < bytes; b++) {
      out.push(value % 256);
      value = Math.floor(value / 256);
    }
  }
  return Uint8Array.from(out);
}

function bits(bytes: Uint8Array, offset: number, count: number) {
  let value = 0;
  for (let i = count - 1; i >= 0; i--) value = value * 2 + ((bytes[(offset + i) >> 3]! >> ((offset + i) & 7)) & 1);
  return value;
}

// Verhoeff check digit (Matter manual codes).
const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const VINV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function verhoeffDigit(digits: string) {
  let c = 0;
  [...digits].reverse().forEach((ch, i) => (c = VD[c]![VP[(i + 1) % 8]![Number(ch)]!]!));
  return String(VINV[c]);
}

function verhoeffValid(digits: string) {
  let c = 0;
  [...digits].reverse().forEach((ch, i) => (c = VD[c]![VP[i % 8]![Number(ch)]!]!));
  return c === 0;
}

const formatHomeKit = (n: number) => {
  const s = String(n).padStart(8, "0");
  return `${s.slice(0, 3)}-${s.slice(3, 5)}-${s.slice(5)}`;
};
const formatMatter = (digits: string) => (digits.length === 11 ? `${digits.slice(0, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}` : digits);

function homekitPayload(raw: string): PairingInfo | null {
  const rest = raw.trim().slice(7).toUpperCase();
  if (!/^[0-9A-Z]{9}[0-9A-Z]{0,4}$/.test(rest)) return null;
  let n = 0;
  for (const ch of rest.slice(0, 9)) n = n * 36 + Number.parseInt(ch, 36);
  const code = n % 2 ** 27;
  const flags = Math.floor(n / 2 ** 27) % 16;
  const category = Math.floor(n / 2 ** 31) % 256;
  const version = Math.floor(n / 2 ** 43) % 8;
  if (code > 99999999) return null;
  const setupId = rest.slice(9);
  return {
    kind: "homekit",
    payload: `X-HM://${rest}`,
    code: formatHomeKit(code),
    category: HOMEKIT_CATEGORIES[category] ?? null,
    details: { ...(setupId ? { setupId } : {}), categoryNumber: category, flags, version },
  };
}

function matterPayload(raw: string): PairingInfo | null {
  const text = raw.trim().slice(3).toUpperCase();
  const bytes = base38(text);
  if (!bytes || bytes.length < 11) return null;
  const version = bits(bytes, 0, 3);
  const vendorId = bits(bytes, 3, 16);
  const productId = bits(bytes, 19, 16);
  const flow = bits(bytes, 35, 2);
  const discriminator = bits(bytes, 45, 12);
  const passcode = bits(bytes, 57, 27);
  if (version !== 0 || passcode < 1 || passcode > 99999998) return null;
  const short = discriminator >> 8;
  const custom = flow !== 0;
  let digits = `${((custom ? 1 : 0) << 2) | (short >> 2)}${String(((short & 3) << 14) | (passcode & 0x3fff)).padStart(5, "0")}${String(passcode >> 14).padStart(4, "0")}`;
  if (custom) digits += `${String(vendorId).padStart(5, "0")}${String(productId).padStart(5, "0")}`;
  digits += verhoeffDigit(digits);
  return {
    kind: "matter",
    payload: `MT:${text}`,
    code: formatMatter(digits),
    category: null,
    details: { vendorId, productId, discriminator, commissioningFlow: flow },
  };
}

/**
 * What a scanned or typed pairing code is — X-HM://…, MT:…, an 8-digit HomeKit code (123-45-678) or an 11/21-digit
 * Matter code (checked) — or null if it isn't one.
 */
export function parsePairing(raw: string): PairingInfo | null {
  const s = raw.trim();
  if (/^X-HM:\/\//i.test(s)) return homekitPayload(s);
  if (/^MT:/i.test(s)) return matterPayload(s);
  const digits = s.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 8) return { kind: "homekit", payload: null, code: formatHomeKit(Number(digits)), category: null, details: {} };
  if ((digits.length === 11 || digits.length === 21) && verhoeffValid(digits)) {
    return { kind: "matter", payload: null, code: formatMatter(digits), category: null, details: {} };
  }
  return null;
}
