/**
 * /api/v1/server — the server's own settings (Settings → Server, the server admin only): who that admin is, and
 * whether things are checked against product recalls.
 */
import { Hono } from "hono";
import { askSettingsInput, promptExtraInput, promptKinds, type ServerAddress, type ServerSecrets, serverAdminInput } from "@ferret/shared";
import { type AppEnv, body, requireServerAdmin, requireUser } from "../lib/context";
import { serverAdmin, setServerAdmin } from "../lib/server-admin";
import { z } from "zod";
import { RECALL_SYNC_JOB } from "../jobs/recalls";
import { recallStatus, setRecallsEnabled } from "../lib/recalls";
import { repairGuideStatus, setRepairGuidesEnabled } from "../lib/repair-guides";
import { askSettings, setAskContextTokens } from "../lib/ask-settings";
import { setPromptExtra } from "../lib/ai-prompts";
import { promptSettings } from "../lib/prompt-settings";
import { setVehiclesEnabled, VIN_BACKFILL_JOB, vehicleStatus } from "../lib/vehicles";
import { fuelEconomyStatus, setFuelEconomyEnabled } from "../lib/fuel-economy";
import { diskSpace } from "../lib/disk-space";
import { setUpdatesEnabled, UPDATE_CHECK_JOB, updatesState, updateStatus } from "../lib/updates";
import { serverAiFillDefaults, setServerAiFillDefaults } from "../lib/ai-fill";
import { aiFillKinds } from "@ferret/shared";
import { demoReport } from "../lib/demo";
import { DEMO_PARTS, partsOff, setPartsOff } from "../lib/demo-switches";
import { HTTPException } from "hono/http-exception";
import { aboutServer, clearServiceErrors, listServiceErrors } from "../lib/service-errors";
import { cardLookupStatus, setCardsEnabled } from "../lib/cards";
import { catalogStatus, saveCatalogKey } from "../lib/collectibles";
import { energyStatus, setElectricityKey, setEnergyEnabled } from "../lib/energy";
import { bikeIndexStatus, setBikeIndexEnabled } from "../lib/bikes";
import { marketStatus, setMarketKey } from "../lib/market";
import { gradingStatus, saveGradingKey } from "../lib/graded";
import { gradingServices } from "@ferret/shared";
import { collectibleKeyInput, collectibleKinds } from "@ferret/shared";
import { SUPPORT_REFRESH_JOB, setSupportEnabled, supportStatus } from "../lib/support";
import { EXCHANGE_RATES_JOB, exchangeRateStatus, setExchangeRatesEnabled } from "../lib/exchange";
import { setGoogleBooksKey, barcodeLookupStatus, bookLookupStatus, musicLookupStatus, openFactsStatus, setBooksEnabled, setMusicEnabled, setOpenFactsEnabled } from "../lib/products";
import { runServerCheck } from "../lib/server-check";
import { reindexEverything, searchIndexStatus } from "../lib/search-index";
import { BACKFILL_JOB } from "../jobs/index-item";
import { MAX_FILE_BYTES, addClient, addTrusted, listCertificates, removeCertificate } from "../lib/certificates";

export const server = new Hono<AppEnv>();
server.use(requireUser, requireServerAdmin);

server.get("/admin", async (c) => c.json(await serverAdmin(c.var.db)));

/** Hands the server admin over to another (confirmed) account: from then on, only they see Settings → Server. */
server.put("/admin", async (c) => {
  const { email } = await body(c.req.raw, serverAdminInput);
  return c.json(await setServerAdmin(c.var.db, email));
});

/** PUBLIC_URL and whether it was set (Settings → Server says to set it when it isn't). */
server.get("/address", (c) => c.json({ set: c.var.config.publicUrlSet, publicUrl: c.var.config.PUBLIC_URL } satisfies ServerAddress));

/** Where each secret came from (Settings → Server → Keys) — never the secrets, bar the push public key. */
server.get("/secrets", (c) => {
  const { config, deps } = c.var;
  const names = ["FILES_KEY", "AUTH_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const;
  const present = { FILES_KEY: true, AUTH_SECRET: true, VAPID_PUBLIC_KEY: !!config.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: !!config.VAPID_PRIVATE_KEY };
  return c.json({
    file: deps.secrets?.file ?? null,
    secrets: names.map((name) => ({ name, source: present[name] ? (deps.secrets?.sources[name] ?? "settings") : "none" })),
    pushPublicKey: deps.push?.publicKey ?? null,
  } satisfies ServerSecrets);
});

/** Failed calls to the services Ferret uses, newest first. */
server.get("/errors", async (c) => c.json({ data: await listServiceErrors(c.var.db, aboutServer(c.var.config, c.var.deps)) }));
/** Clear them (all, or one). */
server.delete("/errors", async (c) => {
  await clearServiceErrors(c.var.db);
  return c.body(null, 204);
});
server.delete("/errors/:id", async (c) => {
  await clearServiceErrors(c.var.db, c.req.param("id"));
  return c.body(null, 204);
});

/** The public demo's use (lib/demo.ts, lib/analytics.ts): only on the demo. */
server.get("/demo", async (c) => {
  if (!c.var.config.DEMO) throw new HTTPException(404, { message: "Not the demo" });
  const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(c.req.query());
  return c.json(await demoReport(c.var.deps, c.var.config, days));
});

/** The demo's parts that are switched off (lib/demo-switches.ts), and switching them. */
server.get("/demo/switches", async (c) => {
  if (!c.var.config.DEMO) throw new HTTPException(404, { message: "Not the demo" });
  return c.json({ off: [...(await partsOff(c.var.db))] });
});
server.put("/demo/switches", async (c) => {
  if (!c.var.config.DEMO) throw new HTTPException(404, { message: "Not the demo" });
  const { off } = await body(c.req.raw, z.object({ off: z.array(z.enum(DEMO_PARTS)).max(DEMO_PARTS.length) }));
  return c.json({ off: [...(await setPartsOff(c.var.db, off))] });
});

/** What the demo's hosting has used, against what its plan includes (the HostingUsage port); null without one. */
server.get("/demo/usage", async (c) => {
  if (!c.var.config.DEMO) throw new HTTPException(404, { message: "Not the demo" });
  const usage = c.var.deps.hostingUsage;
  if (!usage) return c.json({ usage: null, error: null });
  try {
    return c.json({ usage: await usage.report(new Date()), error: null });
  } catch (err) {
    return c.json({ usage: null, error: err instanceof Error ? err.message : String(err) });
  }
});

/** Certificates for Ferret's own connections (lib/certificates.ts): those trusted, and client certificates. */
server.get("/certificates", async (c) => c.json(await listCertificates(c.var.deps)));
server.post("/certificates/trusted", async (c) => {
  const input = await body(c.req.raw, z.object({ name: z.string().max(80).default(""), pem: z.string().min(1).max(MAX_FILE_BYTES) }));
  return c.json(await addTrusted(c.var.deps, c.var.config.FILES_KEY, input), 201);
});
server.post("/certificates/client", async (c) => {
  const input = await body(
    c.req.raw,
    z.object({
      name: z.string().max(80).default(""),
      hosts: z.array(z.string().max(253)).min(1).max(20),
      /** The .p12 / .pfx file, base64. */
      pkcs12: z.string().min(1).max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4).regex(/^[A-Za-z0-9+/]+=*$/, "Not base64"),
      password: z.string().max(200).default(""),
    }),
  );
  return c.json(await addClient(c.var.deps, c.var.config.FILES_KEY, input), 201);
});
server.delete("/certificates/:id", async (c) => c.json(await removeCertificate(c.var.deps, c.var.config.FILES_KEY, c.req.param("id"))));

/** Online barcode lookups: on or off, and what's left of the database's allowance today. */
/** Server check: files, rows pointing at nothing, unfinished work, backups — read-only, on demand. */
server.post("/check", async (c) => c.json(await runServerCheck({ db: c.var.db, blobs: c.var.deps.blobs, files: c.var.files, disk: c.var.deps.disk })));

/** Search by meaning's index: the embedding model and store, how many things are embedded, a re-index under way. */
server.get("/search-index", async (c) => c.json(await searchIndexStatus(c.var.deps)));
/** Re-index everything: clears the vector store and embeds every thing again (for new weights under the same name). */
server.post("/search-index/rebuild", async (c) => {
  const { deps } = c.var;
  if (!deps.ai || !deps.vectors || !deps.jobs) throw new HTTPException(409, { message: "Search by meaning isn't on" });
  await reindexEverything(deps);
  await deps.jobs.enqueue(BACKFILL_JOB, {});
  return c.json(await searchIndexStatus(deps));
});

server.get("/barcode-lookups", async (c) => c.json(await barcodeLookupStatus(c.var.deps)));

/** "Let AI fill in": which kinds are on by default for this server's households (each household can still choose). */
server.get("/ai-fill", async (c) => c.json(await serverAiFillDefaults(c.var.db)));
server.put("/ai-fill", async (c) => {
  const input = await body(c.req.raw, z.partialRecord(z.enum(aiFillKinds), z.boolean()));
  return c.json(await setServerAiFillDefaults(c.var.db, input));
});

/** Book look-ups (Open Library, by ISBN): whether they're on, and how many books are kept. */
server.get("/books", async (c) => c.json(await bookLookupStatus(c.var.deps)));

/** Switch book look-ups on (an ISBN scanned or saved is asked of Open Library) or off. */
server.put("/books", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setBooksEnabled(c.var.db, enabled);
  return c.json(await bookLookupStatus(c.var.deps));
});

/** Exchange rates (the European Central Bank's, via Frankfurter): whether they're on, and the day they're from. */
server.get("/exchange-rates", async (c) => c.json(await exchangeRateStatus(c.var.deps)));

/** Switch exchange rates on (fetched straight away, then daily) or off. */
server.put("/exchange-rates", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setExchangeRatesEnabled(c.var.db, enabled);
  if (enabled && c.var.deps.exchangeRates && c.var.deps.jobs) await c.var.deps.jobs.enqueue(EXCHANGE_RATES_JOB, {});
  return c.json(await exchangeRateStatus(c.var.deps));
});

/** Device support (endoflife.date): whether it's on, device models known and things tracked. */
server.get("/support", async (c) => c.json(await supportStatus(c.var.deps)));

/** Switch device support on (the device lists are downloaded straight away, then daily) or off. */
server.put("/support", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setSupportEnabled(c.var.db, enabled);
  if (enabled && c.var.deps.support && c.var.deps.jobs) await c.var.deps.jobs.enqueue(SUPPORT_REFRESH_JOB, {});
  return c.json(await supportStatus(c.var.deps));
});

/** Open Food Facts look-ups (groceries, household goods, toiletries): whether they're on, and how many products are kept. */
server.get("/open-facts", async (c) => c.json(await openFactsStatus(c.var.deps)));

/** Switch them on (a barcode the product database doesn't know is asked of the Open Food Facts databases) or off. */
server.put("/open-facts", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setOpenFactsEnabled(c.var.db, enabled);
  return c.json(await openFactsStatus(c.var.deps));
});

/** Trading card look-ups (TCGdex for Pokémon, Scryfall for Magic): whether they're on, and how many cards are kept. */
server.get("/cards", async (c) => c.json(await cardLookupStatus(c.var.deps)));

/** Switch card look-ups on ("Scan cards": what's printed on a card is sent to TCGdex or Scryfall) or off. */
server.put("/cards", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setCardsEnabled(c.var.db, enabled);
  return c.json(await cardLookupStatus(c.var.deps));
});

/** Collector catalogs (Rebrickable, Numista, Comic Vine): which have a key, and how much is kept. Keys are never sent back. */
server.get("/collectibles", async (c) => c.json({ data: await catalogStatus(c.var.deps) }));

/** Save a collector catalog's free key (checked with the catalog first) — or `{ key: null }` to remove it and switch it off. */
server.put("/collectibles/:kind", async (c) => {
  const kind = z.enum(collectibleKinds).safeParse(c.req.param("kind"));
  if (!kind.success) throw new HTTPException(404, { message: "No such catalog" });
  const { key } = await body(c.req.raw, collectibleKeyInput);
  return c.json({ data: await saveCatalogKey(c.var.deps, c.var.config.FILES_KEY, kind.data, key) });
});

/** Grading services (PCGS, PSA): which have a key. Keys are never sent back. */
server.get("/graded", async (c) => c.json({ data: await gradingStatus(c.var.deps) }));

/** Save a grading service's key (checked first), or `{ key: null }` to remove it. */
server.put("/graded/:by", async (c) => {
  const by = z.enum(gradingServices).safeParse(c.req.param("by"));
  if (!by.success) throw new HTTPException(404, { message: "No such service" });
  const { key } = await body(c.req.raw, collectibleKeyInput);
  return c.json({ data: await saveGradingKey(c.var.deps, c.var.config.FILES_KEY, by.data, key) });
});

/** Bike Index look-ups: whether they're on, and how many serials are kept. */
server.get("/bike-index", async (c) => c.json(await bikeIndexStatus(c.var.deps)));

/** Switch Bike Index look-ups on (bikes' serial numbers are sent to bikeindex.org) or off. */
server.put("/bike-index", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setBikeIndexEnabled(c.var.db, enabled);
  return c.json(await bikeIndexStatus(c.var.deps));
});

/** ENERGY STAR look-ups: whether they're on, and how many brands and models are kept. */
server.get("/energy-star", async (c) => c.json(await energyStatus(c.var.deps)));

/** Switch ENERGY STAR look-ups on (things' brands and models, or barcodes, are sent to data.energystar.gov) or off. */
server.put("/energy-star", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setEnergyEnabled(c.var.db, enabled);
  return c.json(await energyStatus(c.var.deps));
});

/** The US EIA's electricity prices, to put ENERGY STAR's kWh in money: save its free key (checked first), or `{ key: null }`. */
server.put("/energy-star/electricity", async (c) => {
  const { key } = await body(c.req.raw, collectibleKeyInput);
  return c.json(await setElectricityKey(c.var.deps, c.var.config.FILES_KEY, key));
});

/** eBay listings ("On eBay now" on things' pages): whether a keyset is saved. Keys are never sent back. */
server.get("/ebay", async (c) => c.json(await marketStatus(c.var.deps)));

/** Save the eBay keyset — "<App ID> <Cert ID>", checked with eBay first — or `{ key: null }` to remove it. */
server.put("/ebay", async (c) => {
  const { key } = await body(c.req.raw, collectibleKeyInput);
  return c.json(await setMarketKey(c.var.deps, c.var.config.FILES_KEY, key));
});

/** Google Books, asked after Open Library: save its free key (checked with Google first), or `{ key: null }` to remove it. */
server.put("/books/google", async (c) => {
  const { key } = await body(c.req.raw, collectibleKeyInput);
  return c.json(await setGoogleBooksKey(c.var.deps, c.var.config.FILES_KEY, key));
});

/** Music look-ups (MusicBrainz, for "Scan music"): whether they're on, and how many records are kept. */
server.get("/music", async (c) => c.json(await musicLookupStatus(c.var.deps)));

/** Switch music look-ups on (a barcode scanned with "Scan music" is asked of MusicBrainz) or off. */
server.put("/music", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setMusicEnabled(c.var.db, enabled);
  return c.json(await musicLookupStatus(c.var.deps));
});

/** Repair guide links (iFixit): whether they're on, brands + models asked about and matched. */
server.get("/repair-guides", async (c) => c.json(await repairGuideStatus(c.var.deps)));

/** Switch repair guide links on or off (things are asked about as they're saved, or their pages opened). */
server.put("/repair-guides", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setRepairGuidesEnabled(c.var.db, enabled);
  return c.json(await repairGuideStatus(c.var.deps));
});

/** Ask Ferret: the answering model's context size, and how much a question reads with it. */
server.get("/ask", async (c) => c.json(await askSettings(c.var.db)));

/** Set the answering model's context size ({ contextTokens }, null = the default). */
server.put("/ask", async (c) => {
  const { contextTokens } = await body(c.req.raw, askSettingsInput);
  await setAskContextTokens(c.var.db, contextTokens);
  return c.json(await askSettings(c.var.db));
});

/** AI prompts: each built-in prompt and the extra instructions the admin added to it. */
server.get("/prompts", async (c) => c.json({ data: await promptSettings(c.var.db) }));

/** Set (or clear, with null) the extra instructions added to the end of one built-in prompt. */
server.put("/prompts/:kind", async (c) => {
  const kind = z.enum(promptKinds).safeParse(c.req.param("kind"));
  if (!kind.success) throw new HTTPException(404, { message: "No such prompt" });
  const { extra } = await body(c.req.raw, promptExtraInput);
  await setPromptExtra(c.var.db, kind.data, extra);
  return c.json({ data: await promptSettings(c.var.db) });
});

/** Vehicle look-ups (NHTSA): whether they're on, how many vehicles decoded and their recalls kept. */
server.get("/vehicles", async (c) => c.json(await vehicleStatus(c.var.deps)));

/** Switch vehicle look-ups on (VINs already in Ferret are looked up, then every household checked for recalls) or off. */
server.put("/vehicles", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setVehiclesEnabled(c.var.db, enabled);
  if (enabled) await c.var.deps.jobs?.enqueue(VIN_BACKFILL_JOB, {});
  return c.json(await vehicleStatus(c.var.deps));
});

/** Fuel economy look-ups (fueleconomy.gov): whether they're on, vehicles confirmed, and the week of the fuel prices. */
server.get("/fuel-economy", async (c) => c.json(await fuelEconomyStatus(c.var.deps)));

/** Switch fuel economy look-ups on (decoded vehicles' makes, models and years are sent to fueleconomy.gov) or off. */
server.put("/fuel-economy", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setFuelEconomyEnabled(c.var.db, enabled);
  return c.json(await fuelEconomyStatus(c.var.deps));
});

/** Free space on the disks the database, files and backups are on (none where the server has no disk of its own). */
server.get("/disk", async (c) => c.json({ data: await diskSpace(c.var.deps) }));

/** New versions of Ferret: whether checking is on, this version and the newest release seen. */
server.get("/updates", async (c) => c.json(updateStatus(c.var.deps, c.var.deps.releases?.current ?? c.var.config.FERRET_VERSION, await updatesState(c.var.db))));

/** Switch the daily check for new versions on (GitHub is asked once a day) or off. */
server.put("/updates", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  if (!c.var.deps.releases) throw new HTTPException(409, { message: "This server is updated for you" });
  await setUpdatesEnabled(c.var.db, enabled);
  if (enabled) await c.var.deps.jobs?.enqueue(UPDATE_CHECK_JOB, {});
  return c.json(updateStatus(c.var.deps, c.var.deps.releases?.current ?? c.var.config.FERRET_VERSION, await updatesState(c.var.db)));
});

/** Recall checks: whether they're on, how many brands asked about and recalls kept. */
server.get("/recalls", async (c) => c.json(await recallStatus(c.var.deps)));

/** Switch recall checks on (every household is checked straight away) or off. */
server.put("/recalls", async (c) => {
  const { enabled } = await body(c.req.raw, z.object({ enabled: z.boolean() }));
  await setRecallsEnabled(c.var.db, enabled);
  if (enabled) await c.var.deps.jobs?.enqueue(RECALL_SYNC_JOB, {});
  return c.json(await recallStatus(c.var.deps));
});
