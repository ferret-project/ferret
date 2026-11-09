import { t as translateText } from "./i18n";
/**
 * Key files: the server's secrets — FILES_KEY, and AUTH_SECRET and the push keys with it — sealed with a passphrase, so
 * they can be kept beside the backups (or anywhere) and brought back with `cli.js key recover` on a new server. Web-standard crypto only: PBKDF2-SHA256 → AES-256-GCM, the key's
 * fingerprint (lib/files.ts masterKeyId) bound in as additional data so a file can't be passed off as another key's.
 * Made and opened only from the command line: whoever can run it can already read the server's environment.
 */
import { masterKeyId } from "./files";

export const KEY_FILE_FORMAT = "ferret-key";
/** OWASP's figure for PBKDF2-SHA256 (2023): about a second on a NAS, years per guess list on a stolen file. */
export const KEY_FILE_ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 16;

/** What a key file holds: FILES_KEY always, the others when the server has them. */
export type KeyFileSecrets = { FILES_KEY: string } & Partial<Record<"AUTH_SECRET" | "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY", string>>;
const NAMES = ["FILES_KEY", "AUTH_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;

export interface KeyFile {
  format: typeof KEY_FILE_FORMAT;
  version: 1;
  /** Which FILES_KEY this is (household_key.kek_id, Settings → Server). */
  keyId: string;
  createdAt: string;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher: { name: "AES-GCM"; iv: string };
  sealed: string;
}

const utf8 = new TextEncoder();

/** Why a passphrase won't do, or undefined. Length is what makes a stolen key file slow to guess. */
export function passphraseProblem(passphrase: string): string | undefined {
  if ([...passphrase.normalize("NFC")].length < MIN_PASSPHRASE) {
    return translateText("Use at least {v0} characters — a few unrelated words is easiest. Anyone with the key file can guess offline.", { v0: MIN_PASSPHRASE });
  }
  return undefined;
}

export async function sealKeyFile(secrets: KeyFileSecrets, passphrase: string, opts: { iterations?: number; now?: Date } = {}): Promise<KeyFile> {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const keyId = await masterKeyId(secrets.FILES_KEY);
  const iterations = opts.iterations ?? KEY_FILE_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const held = Object.fromEntries(NAMES.filter((n) => secrets[n]).map((n) => [n, secrets[n]]));
  const raw = utf8.encode(JSON.stringify(held));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(keyId) }, key, raw));
  raw.fill(0);
  return {
    format: KEY_FILE_FORMAT,
    version: 1,
    keyId,
    createdAt: (opts.now ?? new Date()).toISOString(),
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    sealed: toBase64(sealed),
  };
}

/** The secrets in a key file. Throws a plain message for anything that isn't one, or a wrong passphrase. */
export async function openKeyFile(file: unknown, passphrase: string): Promise<KeyFileSecrets> {
  const f = asKeyFile(file);
  const key = await deriveKey(passphrase, fromBase64(f.kdf.salt), f.kdf.iterations);
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(f.cipher.iv), additionalData: aad(f.keyId) }, key, fromBase64(f.sealed)),
    );
  } catch {
    throw new Error(translateText("Wrong passphrase (or the key file was changed)."));
  }
  let held: Record<string, unknown>;
  try {
    held = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    throw new Error(translateText("The key file is damaged: what it holds isn't readable."));
  } finally {
    raw.fill(0);
  }
  const out: Partial<KeyFileSecrets> = {};
  for (const n of NAMES) if (typeof held[n] === "string" && held[n]) out[n] = held[n] as string;
  if (!out.FILES_KEY || (await masterKeyId(out.FILES_KEY)) !== f.keyId) {
    throw new Error(translateText("The key file is damaged: what it holds isn't the key it names."));
  }
  return out as KeyFileSecrets;
}

function asKeyFile(file: unknown): KeyFile {
  const f = file as Partial<KeyFile> | null;
  if (!f || typeof f !== "object" || f.format !== KEY_FILE_FORMAT) throw new Error(translateText("That isn't a Ferret key file."));
  if (f.version !== 1) throw new Error(translateText("This key file is version {v0}; this Ferret reads version 1. Use a newer Ferret.", { v0: String(f.version) }));
  const ok =
    typeof f.keyId === "string" &&
    f.kdf?.name === "PBKDF2" &&
    f.kdf.hash === "SHA-256" &&
    Number.isInteger(f.kdf.iterations) &&
    f.kdf.iterations >= 1 &&
    f.kdf.iterations <= 10_000_000 &&
    typeof f.kdf.salt === "string" &&
    f.cipher?.name === "AES-GCM" &&
    typeof f.cipher.iv === "string" &&
    typeof f.sealed === "string";
  if (!ok) throw new Error(translateText("The key file is damaged (a part of it is missing or not what Ferret wrote)."));
  return f as KeyFile;
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const material = await crypto.subtle.importKey("raw", utf8.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const aad = (keyId: string) => utf8.encode(`${KEY_FILE_FORMAT}:v1:${keyId}`);

function toBase64(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
}
