import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { ItemListing, ItemSearch, PlacesTree } from "@ferret/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { FsBlobs } from "../src/adapters/local/blobs";
import { SharpImages } from "../src/adapters/local/images";
import { mountWebApp } from "../src/adapters/local/web";
import { createLocalDb, runMigrations } from "../src/adapters/local/db";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { verifiedAccount } from "./helpers";

const config = loadConfig({
  NODE_ENV: "test",
  AUTH_SECRET: "test-secret-test-secret-test-secret-123",
  FILES_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  MAX_UPLOAD_MB: "1",
});
const filesDir = mkdtempSync(path.join(tmpdir(), "ferret-test-files-"));
let app: ReturnType<typeof createApp>["app"];
let auth: ReturnType<typeof createApp>["auth"];

beforeAll(async () => {
  const { db } = createLocalDb(":memory:");
  await runMigrations(db, path.resolve(__dirname, "../migrations"));
  ({ app, auth } = createApp({ db, blobs: new FsBlobs(filesDir), images: new SharpImages() }, config));
});

/** A signed-in user (email confirmed) and a fetch helper that carries their session cookie. */
async function signUp(name: string) {
  const { cookie } = await verifiedAccount(app, auth, name);
  return (url: string, init: RequestInit = {}) =>
    app.request(url, {
      ...init,
      headers: {
        // FormData bodies set their own multipart Content-Type (with boundary).
        ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        Origin: config.PUBLIC_URL,
        Cookie: cookie,
        ...init.headers,
      },
    });
}

async function createHousehold(as: Awaited<ReturnType<typeof signUp>>, name: string) {
  const res = await as("/api/auth/organization/create", {
    method: "POST",
    body: JSON.stringify({ name, slug: name.toLowerCase().replace(/\W+/g, "-") }),
  });
  expect(res.status).toBe(200);
  const org = (await res.json()) as { id: string };
  return org.id;
}

describe("Ferret API", () => {
  it("health check", async () => {
    const res = await app.request("/healthz");
    expect(await res.json()).toEqual({ ok: true, app: "ferret" });
  });

  it("serves the web app without swallowing unknown API paths", async () => {
    const webRoot = mkdtempSync(path.join(tmpdir(), "ferret-test-web-"));
    writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>Ferret</title>");
    const { db } = createLocalDb(":memory:");
    await runMigrations(db, path.resolve(__dirname, "../migrations"));
    const web = createApp({ db, blobs: new FsBlobs(filesDir) }, config).app;
    mountWebApp(web, webRoot);

    const page = await web.request("/items/123"); // a client-side route
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>Ferret</title>");

    const unknown = await web.request("/api/v1/nope");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("sends the web app's files compressed, and caches only the hashed ones for long", async () => {
    const webRoot = mkdtempSync(path.join(tmpdir(), "ferret-test-web-"));
    mkdirSync(path.join(webRoot, "assets"));
    writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>Ferret</title>");
    writeFileSync(path.join(webRoot, "assets/index-abc123.js"), "console.log('plain')");
    writeFileSync(path.join(webRoot, "assets/index-abc123.js.br"), "brotli bytes");
    const { db } = createLocalDb(":memory:");
    await runMigrations(db, path.resolve(__dirname, "../migrations"));
    const web = createApp({ db, blobs: new FsBlobs(filesDir) }, config).app;
    mountWebApp(web, webRoot);

    const br = await web.request("/assets/index-abc123.js", { headers: { "Accept-Encoding": "gzip, br" } });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(await br.text()).toBe("brotli bytes");
    expect(br.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const plain = await web.request("/assets/index-abc123.js");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe("console.log('plain')");
    // The page names the hashed files, so it's checked every time: a new version shows at once.
    expect((await web.request("/")).headers.get("cache-control")).toBe("no-cache");
    expect((await web.request("/items/123")).headers.get("cache-control")).toBe("no-cache");
  });

  it("rejects anonymous access", async () => {
    expect((await app.request("/api/v1/items")).status).toBe(401);
  });

  it("creates and searches items inside a household", async () => {
    const sam = await signUp("sam");
    const householdId = await createHousehold(sam, "Highland House");

    const prop = await sam("/api/v1/properties", { method: "POST", body: JSON.stringify({ name: "Highland House" }) });
    expect(prop.status).toBe(201);
    const { id: propertyId } = (await prop.json()) as { id: string };

    const garage = await sam("/api/v1/locations", {
      method: "POST",
      body: JSON.stringify({ propertyId, name: "Garage" }),
    });
    const { id: locationId } = (await garage.json()) as { id: string };

    const created = await sam("/api/v1/items", {
      method: "POST",
      body: JSON.stringify({ name: "Cordless drill", brand: "DeWalt", locationId, valueCents: 12900 }),
    });
    expect(created.status).toBe(201);
    const drill = (await created.json()) as { id: string; householdId: string };
    expect(drill.householdId).toBe(householdId);

    const found = (await (await sam("/api/v1/items?q=dewalt")).json()) as { total: number };
    expect(found.total).toBe(1);

    const patched = await sam(`/api/v1/items/${drill.id}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity: 2 }),
    });
    expect(((await patched.json()) as { quantity: number }).quantity).toBe(2);

    expect((await sam(`/api/v1/items/${drill.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await sam(`/api/v1/items/${drill.id}`)).status).toBe(404);
  });

  it("keeps households isolated", async () => {
    const alice = await signUp("alice");
    const aliceHome = await createHousehold(alice, "Alice Home");
    await alice("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "Secret stash" }) });

    const bob = await signUp("bob");
    await createHousehold(bob, "Bob Home");
    const bobItems = (await (await bob("/api/v1/items")).json()) as { total: number };
    expect(bobItems.total).toBe(0);

    // Bob can't read Alice's household by forcing the header.
    const sneaky = await bob("/api/v1/items", { headers: { "X-Household-Id": aliceHome } });
    expect(sneaky.status).toBe(403);
  });

  it("manages places: tree, rename, nested listing, and only empty places can go", async () => {
    const owner = await signUp("placer");
    await createHousehold(owner, "Places Home");
    const json = async <T>(res: Response | Promise<Response>) => (await res).json() as Promise<T>;
    const post = (url: string, data: object) => owner(url, { method: "POST", body: JSON.stringify(data) });

    const home = await json<{ id: string }>(post("/api/v1/properties", { name: "Lake House", type: "vacation" }));
    const garage = await json<{ id: string }>(post("/api/v1/locations", { propertyId: home.id, name: "Garage" }));
    const shelf = await json<{ id: string }>(post("/api/v1/locations", { propertyId: home.id, parentId: garage.id, name: "Shelf" }));
    const drill = await json<{ id: string }>(post("/api/v1/items", { name: "Drill", locationId: shelf.id }));

    const tree = await json<PlacesTree>(owner("/api/v1/locations/tree"));
    expect(tree.properties[0]!.locations[0]!.children[0]).toMatchObject({ name: "Shelf", path: "Lake House › Garage › Shelf", itemCount: 1 });

    // Lists say where things are, and a location includes what's nested in it.
    const inGarage = await json<ItemSearch>(owner(`/api/v1/items?locationId=${garage.id}`));
    expect(inGarage.data.map((i) => [i.name, i.place, i.photoId])).toEqual([["Drill", "Lake House › Garage › Shelf", null]]);

    // Renaming keeps the type (no defaults on a patch) and shows up in paths.
    const renamed = await json<{ name: string; type: string }>(
      owner(`/api/v1/properties/${home.id}`, { method: "PATCH", body: JSON.stringify({ name: "Cabin" }) }),
    );
    expect(renamed).toMatchObject({ name: "Cabin", type: "vacation" });

    // Details for insurance: address, year built, value — and the tree carries them.
    await owner(`/api/v1/properties/${home.id}`, {
      method: "PATCH",
      body: JSON.stringify({ street: "1 Lake Rd", city: "Granby", yearBuilt: 1962, valueCents: 45000000 }),
    });
    const withDetails = await json<PlacesTree>(owner("/api/v1/locations/tree"));
    expect(withDetails.properties[0]).toMatchObject({
      name: "Cabin",
      details: { street: "1 Lake Rd", city: "Granby", yearBuilt: 1962, valueCents: 45000000 },
    });
    expect((await owner(`/api/v1/properties/${home.id}`, { method: "PATCH", body: JSON.stringify({ yearBuilt: 1200 }) })).status).toBe(422);
    expect((await json<ItemListing>(owner(`/api/v1/items/${drill.id}`))).place).toBe("Cabin › Garage › Shelf");

    // Something is still kept there, so neither the garage nor the property can go.
    const blocked = await owner(`/api/v1/locations/${garage.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
    expect((await owner(`/api/v1/properties/${home.id}`, { method: "DELETE" })).status).toBe(409);

    await owner(`/api/v1/items/${drill.id}`, { method: "PATCH", body: JSON.stringify({ locationId: null }) });
    expect((await owner(`/api/v1/locations/${garage.id}`, { method: "DELETE" })).status).toBe(204);
    const after = await json<PlacesTree>(owner("/api/v1/locations/tree"));
    expect(after.properties[0]!.locations).toEqual([]);
    expect(after.unplacedItems).toBe(1);
    expect((await owner(`/api/v1/properties/${home.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await json<PlacesTree>(owner("/api/v1/locations/tree"))).properties).toEqual([]);
  });

  describe("attachments", () => {
    // Smallest files that pass sniffing: a PNG signature and a PDF header.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("pixels!")]);
    const upload = (bytes: Uint8Array<ArrayBuffer>, name: string, type: string, kind?: string) => {
      const form = new FormData();
      form.set("file", new File([bytes], name, { type }));
      if (kind) form.set("kind", kind);
      return { method: "POST", body: form };
    };

    async function itemFor(name: string) {
      const as = await signUp(name);
      const householdId = await createHousehold(as, `${name} home`);
      const res = await as("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "Lamp" }) });
      const { id } = (await res.json()) as { id: string };
      return { as, householdId, itemId: id };
    }

    it("gives lists the first photo as a thumbnail", async () => {
      const { as, itemId } = await itemFor("thumbs");
      const res = await as(`/api/v1/items/${itemId}/attachments`, upload(png, "lamp.png", "image/png"));
      const { id } = (await res.json()) as { id: string };
      await as(`/api/v1/items/${itemId}/attachments`, upload(png, "second.png", "image/png"));
      const list = (await (await as("/api/v1/items")).json()) as ItemSearch;
      expect(list.data[0]!.photoId).toBe(id);
    });

    it("stores files encrypted and returns the original bytes", async () => {
      const { as, householdId, itemId } = await itemFor("dana");
      const res = await as(`/api/v1/items/${itemId}/attachments`, upload(png, "lamp.png", "image/png"));
      expect(res.status).toBe(201);
      const photo = (await res.json()) as Record<string, unknown>;
      expect(photo).toMatchObject({ itemId, householdId, kind: "photo", contentType: "image/png", size: png.length });
      expect(photo).not.toHaveProperty("blobKey");

      const list = (await (await as(`/api/v1/items/${itemId}/attachments`)).json()) as { data: unknown[] };
      expect(list.data).toHaveLength(1);

      const content = await as(`/api/v1/attachments/${photo.id}/content`);
      expect(content.status).toBe(200);
      expect(content.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(png);

      // On disk it's ciphertext: format byte 1, no PNG signature, not the plaintext.
      const onDisk = readFileSync(path.join(filesDir, householdId, String(photo.id)));
      expect(onDisk[0]).toBe(1);
      expect(Buffer.from(onDisk).includes(Buffer.from("pixels!"))).toBe(false);
    });

    it("makes an upright, metadata-free WebP thumbnail", async () => {
      const { as, householdId, itemId } = await itemFor("kim");
      // 2000×1000 JPEG tagged "rotate 90°" with EXIF (stand-in for a phone photo with GPS etc.).
      const photo = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#a0522d" } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .withExif({ IFD0: { Copyright: "secret location" } })
        .toBuffer();
      const res = await as(`/api/v1/items/${itemId}/attachments`, upload(new Uint8Array(photo), "drill.jpg", "image/jpeg"));
      const { id } = (await res.json()) as { id: string };

      const thumb = await as(`/api/v1/attachments/${id}/thumbnail`);
      expect(thumb.status).toBe(200);
      expect(thumb.headers.get("content-type")).toBe("image/webp");
      const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
      expect([meta.width, meta.height]).toEqual([300, 600]); // rotated upright, longest side 600
      expect(meta.exif).toBeUndefined();

      // The thumbnail is encrypted at rest too.
      const onDisk = readFileSync(path.join(filesDir, householdId, `${id}.thumb`));
      expect(onDisk[0]).toBe(1);
      expect(Buffer.from(onDisk).includes(Buffer.from("WEBP"))).toBe(false);
    });

    it("falls back to the original when no thumbnail can be made", async () => {
      const { as, itemId } = await itemFor("lee");
      // A PNG signature with garbage after it: passes sniffing, but can't be decoded.
      const res = await as(`/api/v1/items/${itemId}/attachments`, upload(png, "odd.png", "image/png"));
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const thumb = await as(`/api/v1/attachments/${id}/thumbnail`);
      expect(thumb.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(png);
    });

    it("sniffs the real type instead of trusting the upload", async () => {
      const { as, itemId } = await itemFor("erin");
      const html = new TextEncoder().encode("<html><script>alert(1)</script>");
      const res = await as(`/api/v1/items/${itemId}/attachments`, upload(html, "evil.png", "image/png"));
      expect(res.status).toBe(415);

      const pdf = new TextEncoder().encode("%PDF-1.7 receipt");
      expect((await as(`/api/v1/items/${itemId}/attachments`, upload(pdf, "r.pdf", "application/pdf"))).status).toBe(415);
      const doc = await as(`/api/v1/items/${itemId}/attachments`, upload(pdf, "r.pdf", "application/pdf", "document"));
      expect(doc.status).toBe(201);
    });

    it("rejects files over the size limit", async () => {
      const { as, itemId } = await itemFor("fay");
      const big = new Uint8Array(1024 * 1024 + 1).fill(1);
      big.set(png);
      expect((await as(`/api/v1/items/${itemId}/attachments`, upload(big, "big.png", "image/png"))).status).toBe(413);
    });

    it("keeps other households out", async () => {
      const { as, householdId, itemId } = await itemFor("gail");
      const res = await as(`/api/v1/items/${itemId}/attachments`, upload(png, "lamp.png", "image/png"));
      const { id } = (await res.json()) as { id: string };

      const { as: hank } = await itemFor("hank");
      expect((await hank(`/api/v1/attachments/${id}/content`)).status).toBe(404);
      expect((await hank(`/api/v1/items/${itemId}/attachments`, upload(png, "x.png", "image/png"))).status).toBe(404);
      const forced = await hank(`/api/v1/attachments/${id}/content`, { headers: { "X-Household-Id": householdId } });
      expect(forced.status).toBe(403);
    });

    it("refuses tampered ciphertext", async () => {
      const { as, householdId, itemId } = await itemFor("ivy");
      const res = await as(`/api/v1/items/${itemId}/attachments`, upload(png, "lamp.png", "image/png"));
      const { id } = (await res.json()) as { id: string };
      const file = path.join(filesDir, householdId, id);
      const bytes = readFileSync(file);
      bytes[bytes.length - 1]! ^= 0xff;
      writeFileSync(file, bytes);
      expect((await as(`/api/v1/attachments/${id}/content`)).status).toBe(500);
    });

    it("soft-deletes attachments", async () => {
      const { as, itemId } = await itemFor("jo");
      const res = await as(`/api/v1/items/${itemId}/attachments`, upload(png, "lamp.png", "image/png"));
      const { id } = (await res.json()) as { id: string };
      expect((await as(`/api/v1/attachments/${id}`, { method: "DELETE" })).status).toBe(204);
      expect((await as(`/api/v1/attachments/${id}/content`)).status).toBe(404);
    });
  });

  it("validates input", async () => {
    const carol = await signUp("carol");
    await createHousehold(carol, "Carol Home");
    const res = await carol("/api/v1/items", { method: "POST", body: JSON.stringify({ name: "" }) });
    expect(res.status).toBe(422);
  });
});
