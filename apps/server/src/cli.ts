/**
 * Ferret from the command line (Node), for what's done on the server itself. In the container:
 *   docker compose exec ferret node dist/cli.js admin                  who the server admin is
 *   docker compose exec ferret node dist/cli.js admin you@example.com  hand it to another (confirmed) account
 *   docker compose run --rm ferret node dist/cli.js backup list
 *   docker compose run --rm ferret node dist/cli.js backup check [snapshot]
 *   docker compose run --rm -v /path/to/new-data:/restore ferret node dist/cli.js backup restore /restore [snapshot]
 *   docker compose exec ferret node dist/cli.js key fingerprint                  which FILES_KEY is in use
 *   docker compose exec -it ferret node dist/cli.js key export /backups          the secrets, sealed with a passphrase
 *   docker compose run --rm -v ./ferret-key-….json:/k.json ferret node dist/cli.js key recover /k.json [/data]
 *   docker compose run --rm ferret node dist/cli.js secrets new AUTH_SECRET     a new one, on purpose (when it's lost)
 *   docker compose exec ferret node dist/cli.js certificates list               what Ferret trusts for its own connections
 *   docker compose exec -T ferret node dist/cli.js certificates trust - "Home CA" < home-ca.pem
 *   docker compose exec ferret node dist/cli.js certificates remove <id or name>
 *   docker compose exec ferret node dist/cli.js service-keys list               outside services' keys (last four only)
 *   docker compose exec -it ferret node dist/cli.js service-keys set tmdb       asks for the key, checks it, saves it
 *   docker compose exec -T ferret node dist/cli.js service-keys set tmdb < tmdb.key
 *   docker compose exec ferret node dist/cli.js service-keys remove tmdb
 * Reads .env (DATA_DIR, BACKUP_DIR, and the secrets — else the ones Ferret made, in DATA_DIR/secrets.json).
 * In dev: pnpm --filter @ferret/server cli admin
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { FolderBackupTarget, SqliteSnapshots } from "./adapters/local/backup";
import { createLocalDb } from "./adapters/local/db";
import { restoreBackup } from "./adapters/local/restore";
import { checkSnapshot, listSnapshots, readManifest } from "./lib/backup";
import { serverAdmin, setServerAdmin } from "./lib/server-admin";
import { masterKeyId } from "./lib/files";
import { openKeyFile, passphraseProblem, sealKeyFile } from "./lib/key-file";
import { recordKeyFile } from "./lib/key-file-log";
import { DbJobs } from "./adapters/local/jobs";
import { NodeTls } from "./adapters/local/certificates";
import { addTrusted, listCertificates, removeCertificate } from "./lib/certificates";
import { RebrickableSets } from "./adapters/local/rebrickable";
import { NumistaCoins } from "./adapters/local/numista";
import { ComicVineIssues } from "./adapters/local/comicvine";
import { TmdbVideos } from "./adapters/local/tmdb";
import { IgdbGames } from "./adapters/local/igdb";
import { DiscogsRecords } from "./adapters/local/discogs";
import { GoogleBooks } from "./adapters/local/googlebooks";
import { EiaElectricity, EiaFuel } from "./adapters/local/eia";
import { PcgsGrading } from "./adapters/local/pcgs";
import { PsaGrading } from "./adapters/local/psa";
import { saveCatalogKey } from "./lib/collectibles";
import { saveGradingKey } from "./lib/graded";
import { EIA_KEY, setElectricityKey } from "./lib/energy";
import { GOOGLE_BOOKS_KEY, setGoogleBooksKey } from "./lib/products";
import { savedKeyHints } from "./lib/server-keys";
import type { Db } from "./ports";
import { SECRETS_FILE, currentSecrets, readStoredSecrets, replaceAuthSecret, writeStoredSecrets } from "./adapters/local/secrets";

const USAGE = `Usage: cli.js admin [email] | backup list | backup check [snapshot] | backup restore <data folder> [snapshot]
       | key fingerprint | key export <folder or file> | key recover <key file> [data folder] | secrets new AUTH_SECRET
       | certificates list | certificates trust <pem file, or - for stdin> [name] | certificates remove <id or name>
       | service-keys list | service-keys set <service> | service-keys remove <service>`;
const [command, ...args] = process.argv.slice(2);
const dataDir = () => path.resolve(process.env.DATA_DIR?.trim() || "./data");
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} (it's in .env).`);
  return value;
};
/** FILES_KEY from the settings, else the one Ferret made (secrets.json). */
const filesKeyInUse = () => {
  const key = currentSecrets(process.env, dataDir()).FILES_KEY;
  if (!key) throw new Error("No FILES_KEY: not in the settings, nor made by Ferret in this data folder. Lost it? cli.js key recover <key file>.");
  return key;
};

async function admin(email?: string) {
  const dbFile = path.join(path.resolve(process.env.DATA_DIR ?? "./data"), "ferret.db");
  const { db, client } = createLocalDb(`file:${dbFile}`);
  try {
    const who = email ? await setServerAdmin(db, email) : await serverAdmin(db);
    console.log(who ? `${email ? "The server admin is now" : "Server admin:"} ${who.name} <${who.email}>` : "No accounts yet");
  } finally {
    client.close();
  }
}

async function backup(sub: string | undefined, rest: string[]) {
  const filesKey = filesKeyInUse();
  const target = new FolderBackupTarget(path.resolve(env("BACKUP_DIR")));
  if (sub === "list") {
    for (const name of await listSnapshots(target)) {
      const m = await readManifest(target, name);
      console.log(`${name}  ${m.createdAt}  ${m.counts.items} items, ${m.files.length} files`);
    }
  } else if (sub === "check") {
    const name = rest[0] ?? (await listSnapshots(target))[0];
    if (!name) throw new Error(`No backups in ${target.where}`);
    const { summary } = await checkSnapshot({ snapshots: new SqliteSnapshots(createLocalDb(":memory:").db), target, filesKey }, name);
    console.log(`${name}: ${summary}`);
  } else if (sub === "restore" && rest[0]) {
    const into = path.resolve(rest[0]);
    await restoreBackup({ target, filesKey, dataDir: into, snapshot: rest[1], log: console.log });
    // The secrets Ferret made go with the restored folder, so it starts as it was (backups never hold them).
    const stored = readStoredSecrets(dataDir());
    if (Object.keys(stored).length && !existsSync(path.join(into, SECRETS_FILE))) {
      writeStoredSecrets(into, stored);
      console.log(`Copied the secrets Ferret made (${SECRETS_FILE}) into ${into}.`);
    }
  } else {
    throw new Error(USAGE);
  }
}

/**
 * Asks for a passphrase without showing it. Without a terminal (piped in), reads one line — so `docker exec -i` and
 * scripts work too.
 */
async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin });
    const line = await new Promise<string>((resolve) => rl.once("line", resolve).once("close", () => resolve("")));
    rl.close();
    return line;
  }
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          return resolve(value);
        } else if (ch === "\u0003") {
          done();
          return reject(new Error("Cancelled."));
        } else if (ch === "\u007f" || ch === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (ch >= " ") {
          value += ch;
        }
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    stdin.on("data", onData);
  });
}

/** Records the key file in Ferret's database and tells the server admin (lib/key-file-log.ts) — once it's written. */
async function noteKeyFile(record: { at: string; keyId: string; where: string }) {
  const dbFile = path.join(dataDir(), "ferret.db");
  if (!existsSync(dbFile)) return console.log("(No Ferret database here, so the server admin isn't told about this key file.)");
  const { db, client } = createLocalDb(`file:${dbFile}`);
  try {
    await recordKeyFile(db, new DbJobs(db), record);
    console.log("The server admin will be told, and Settings → Server shows it.");
  } catch (err) {
    console.log(`(Couldn't note the key file in Ferret's database: ${err instanceof Error ? err.message : String(err)})`);
  } finally {
    client.close();
  }
}

async function key(sub: string | undefined, rest: string[]) {
  if (sub === "fingerprint") {
    console.log(`FILES_KEY fingerprint: ${await masterKeyId(filesKeyInUse())}`);
  } else if (sub === "export" && rest[0]) {
    const secrets = { ...currentSecrets(process.env, dataDir()), FILES_KEY: filesKeyInUse() };
    const keyId = await masterKeyId(secrets.FILES_KEY);
    const target = path.resolve(rest[0]);
    const file = existsSync(target) && statSync(target).isDirectory() ? path.join(target, `ferret-key-${keyId}.json`) : target;
    const held = Object.keys(secrets).filter((k) => secrets[k as keyof typeof secrets]);
    console.log(`The key file holds this server's secrets (${held.join(", ")}), sealed with a passphrase.`);
    console.log("Anyone with the file can try passphrases offline, so make it long — a few unrelated words. Without the");
    console.log("passphrase, the file is no use to anyone, you included.");
    const passphrase = await askHidden("Passphrase: ");
    const problem = passphraseProblem(passphrase);
    if (problem) throw new Error(problem);
    if (process.stdin.isTTY && (await askHidden("Again: ")) !== passphrase) throw new Error("The two didn't match.");
    const sealed = await sealKeyFile(secrets, passphrase);
    writeFileSync(file, `${JSON.stringify(sealed, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    console.log(`Written: ${file} (FILES_KEY ${keyId})`);
    console.log("Copy it off this server — beside the backups is fine — and keep the passphrase in your password manager.");
    await noteKeyFile({ at: new Date().toISOString(), keyId, where: file });
  } else if (sub === "recover" && rest[0]) {
    const file = JSON.parse(readFileSync(path.resolve(rest[0]), "utf8")) as unknown;
    const secrets = await openKeyFile(file, await askHidden("Passphrase: "));
    if (rest[1]) {
      // Into a data folder: Ferret uses them from there (unless its settings set others).
      const into = path.resolve(rest[1]);
      writeStoredSecrets(into, { ...readStoredSecrets(into), ...secrets });
      console.log(`Written: ${path.join(into, SECRETS_FILE)} (${Object.keys(secrets).join(", ")}). Start Ferret with that data folder.`);
      console.log("Values in Ferret's settings still win over these — leave those empty, or set them to the same.");
    } else {
      for (const [name, value] of Object.entries(secrets)) console.log(`${name}=${value}`);
      console.log("Put those in Ferret's settings (.env, the Unraid template, the TrueNAS app) — or name a data folder after");
      console.log("the key file to write them there instead — and start Ferret.");
    }
  } else {
    throw new Error(USAGE);
  }
}

/** `secrets new AUTH_SECRET`: when it's lost for good. Signs everyone out; two-step sign-in is set up again. */
async function secretsCommand(sub: string | undefined, rest: string[]) {
  if (sub !== "new" || rest[0] !== "AUTH_SECRET") throw new Error(USAGE);
  if (process.env.AUTH_SECRET?.trim()) {
    throw new Error("AUTH_SECRET is set in Ferret's settings — change it there (or empty it, then run this again).");
  }
  const dbFile = path.join(dataDir(), "ferret.db");
  if (!existsSync(dbFile)) throw new Error(`No Ferret database in ${dataDir()}.`);
  const { db, client } = createLocalDb(`file:${dbFile}`);
  try {
    const reset = await replaceAuthSecret(dataDir(), db);
    console.log(`A new AUTH_SECRET is in ${path.join(dataDir(), SECRETS_FILE)}. Restart Ferret: everyone signs in again.`);
    if (reset) console.log(`Two-step sign-in was turned off for ${reset} ${reset === 1 ? "account" : "accounts"}; they set it up again in Settings → Security.`);
  } finally {
    client.close();
  }
}

/** Reads all of stdin (for `certificates trust -`). */
async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `certificates list | trust | remove`: what Settings → Server → Certificates does, for a setup with no browser at
 * hand. A running Ferret notices the change within a minute (server.ts) — no restart. Client certificates (.p12 and a
 * password) stay in Settings.
 */
async function certificates(sub: string | undefined, rest: string[]) {
  const dbFile = path.join(dataDir(), "ferret.db");
  if (!existsSync(dbFile)) throw new Error(`No Ferret database in ${dataDir()}.`);
  const { db, client } = createLocalDb(`file:${dbFile}`);
  const deps = { db, tls: new NodeTls() };
  const show = (list: Awaited<ReturnType<typeof listCertificates>>) => {
    const rows = [...list.trusted.map((c) => ({ ...c, kind: "trusted" })), ...list.clients.map((c) => ({ ...c, kind: `client → ${(c.hosts ?? []).join(", ")}` }))];
    if (!rows.length) return console.log("No certificates of Ferret's own (only the usual public authorities are trusted).");
    for (const c of rows) {
      console.log(`${c.id}  ${c.name}  (${c.kind})`);
      console.log(`    ${c.subject}, issued by ${c.issuer}; until ${c.notAfter.slice(0, 10)}; SHA-256 ${c.fingerprint}`);
    }
  };
  try {
    if (sub === "list") {
      show(await listCertificates(deps));
    } else if (sub === "trust" && rest[0]) {
      const pem = rest[0] === "-" ? await readStdin() : readFileSync(path.resolve(rest[0]), "utf8");
      const before = new Set((await listCertificates(deps)).trusted.map((c) => c.id));
      const after = await addTrusted(deps, filesKeyInUse(), { name: rest.slice(1).join(" "), pem });
      for (const c of after.trusted.filter((t) => !before.has(t.id))) console.log(`Trusted: ${c.name} (${c.subject}, until ${c.notAfter.slice(0, 10)})`);
      console.log("A running Ferret uses it within a minute.");
    } else if (sub === "remove" && rest[0]) {
      const which = rest.join(" ");
      const list = await listCertificates(deps);
      const found = [...list.trusted, ...list.clients].filter((c) => c.id === which || c.name === which);
      if (!found.length) throw new Error(`No certificate with the id or name "${which}" (cli.js certificates list).`);
      if (found.length > 1) throw new Error(`Several certificates are called "${which}" — give its id.`);
      await removeCertificate(deps, filesKeyInUse(), found[0]!.id);
      console.log(`Removed: ${found[0]!.name}. A running Ferret stops using it within a minute.`);
    } else {
      throw new Error(USAGE);
    }
  } finally {
    client.close();
  }
}

/**
 * `service-keys list | set | remove`: the outside services' keys Settings → Server takes (collector catalogs, Google
 * Books, the EIA, PCGS/PSA), for a server admin at a shell. Each goes through the same code as Settings: checked with
 * the service before it's saved, sealed (lib/server-keys.ts), and whatever saving it starts (the EIA's prices) queued.
 * The key is asked for without showing it, or read from stdin — never an argument, so it stays out of shell history
 * and `ps`. A running Ferret uses it at once (keys are read from the database each time).
 */
type ServiceKey = { name: string; note?: string; setting: string; save: (db: Db, filesKey: string, key: string | null) => Promise<unknown> };
const catalogKey = (name: string, kind: "lego" | "coin" | "comic" | "video" | "game" | "record", catalog: object): ServiceKey => ({
  name,
  setting: `collectibles.${kind}.key`,
  save: (db, filesKey, key) => saveCatalogKey({ db, collectibles: { [kind]: catalog } }, filesKey, kind, key),
});
const noKey = async () => null;
const SERVICE_KEYS: Record<string, ServiceKey> = {
  rebrickable: catalogKey("Rebrickable (LEGO sets)", "lego", new RebrickableSets()),
  numista: catalogKey("Numista (coins)", "coin", new NumistaCoins()),
  comicvine: catalogKey("Comic Vine (comics)", "comic", new ComicVineIssues()),
  tmdb: catalogKey("TMDB (films and TV)", "video", new TmdbVideos()),
  igdb: { ...catalogKey("IGDB (video games)", "game", new IgdbGames()), note: "the Twitch app's client ID and secret, separated by a space" },
  discogs: catalogKey("Discogs (records and CDs)", "record", new DiscogsRecords()),
  "google-books": {
    name: "Google Books",
    setting: GOOGLE_BOOKS_KEY,
    save: (db, filesKey, key) => setGoogleBooksKey({ db, googleBooks: new GoogleBooks(noKey) }, filesKey, key),
  },
  eia: {
    name: "EIA (electricity and fuel prices)",
    setting: EIA_KEY,
    save: (db, filesKey, key) => setElectricityKey({ db, electricity: new EiaElectricity(noKey), fuelPrices: new EiaFuel(noKey), jobs: new DbJobs(db) }, filesKey, key),
  },
  pcgs: { name: "PCGS (graded coins)", setting: "graded.pcgs.key", save: (db, filesKey, key) => saveGradingKey({ db, grading: { pcgs: new PcgsGrading() } }, filesKey, "pcgs", key) },
  psa: { name: "PSA (graded cards)", setting: "graded.psa.key", save: (db, filesKey, key) => saveGradingKey({ db, grading: { psa: new PsaGrading() } }, filesKey, "psa", key) },
};

async function serviceKeys(sub: string | undefined, rest: string[]) {
  const dbFile = path.join(dataDir(), "ferret.db");
  if (!existsSync(dbFile)) throw new Error(`No Ferret database in ${dataDir()}.`);
  const service = rest[0] ? SERVICE_KEYS[rest[0]] : undefined;
  if ((sub === "set" || sub === "remove") && !service) {
    throw new Error(`Which service? One of: ${Object.keys(SERVICE_KEYS).join(", ")}`);
  }
  const { db, client } = createLocalDb(`file:${dbFile}`);
  try {
    if (sub === "list") {
      const hints = await savedKeyHints(db, "%.key");
      for (const [id, s] of Object.entries(SERVICE_KEYS)) console.log(`${id.padEnd(13)} ${(hints.get(s.setting) ?? "—").padEnd(7)} ${s.name}`);
    } else if (sub === "set" && service) {
      // Piped in, every line counts (IGDB's two parts may be on two lines), joined with a space.
      const key = process.stdin.isTTY ? (await askHidden(`${service.name} key${service.note ? ` (${service.note})` : ""}: `)).trim() : (await readStdin()).trim().split(/\s+/).join(" ");
      if (!key) throw new Error("No key given.");
      await service.save(db, filesKeyInUse(), key);
      console.log(`Saved the ${service.name} key (…${key.slice(-4)}), after ${service.name.split(" ")[0]} accepted it.`);
    } else if (sub === "remove" && service) {
      await service.save(db, filesKeyInUse(), null);
      console.log(`Removed the ${service.name} key.`);
    } else {
      throw new Error(USAGE);
    }
  } finally {
    client.close();
  }
}

try {
  if (command === "certificates") await certificates(args[0], args.slice(1));
  else if (command === "service-keys") await serviceKeys(args[0], args.slice(1));
  else if (command === "admin") await admin(args[0]);
  else if (command === "key") await key(args[0], args.slice(1));
  else if (command === "secrets") await secretsCommand(args[0], args.slice(1));
  else if (command === "backup") await backup(args[0], args.slice(1));
  else throw new Error(USAGE);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
