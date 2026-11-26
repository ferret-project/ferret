/** Bringing back a thing exported from Ferret: what the check says about its signature, and what an import adds. */
import type { ItemImportCheck, ItemImportResult, ItemListing, SigningKey } from "@ferret/shared";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { pdf, setup } from "./helpers";

const PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("drill photo")]);
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
type As = (url: string, init?: RequestInit) => Response | Promise<Response>;

async function exported() {
  const t = await setup();
  const ann = await t.user("ann");
  const send = <T = { id: string }>(method: string, url: string, body?: object) => json<T>(ann.as(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const house = await send("POST", "/api/v1/properties", { name: "Highland House" });
  const garage = await send("POST", "/api/v1/locations", { propertyId: house.id, name: "Garage" });
  const it = await ann.addItem({ name: "Cordless drill", brand: "DeWalt", serialNumber: "SN-42", locationId: garage.id, valueCents: 11000, replacementCents: 15000, tags: ["Power tools"] });
  await ann.upload(it.id, PHOTO, "drill.png");
  await ann.upload(it.id, pdf("DeWalt receipt"), "receipt.pdf", "document");
  const w = await send("POST", `/api/v1/items/${it.id}/warranties`, { endsOn: "2029-05-01", provider: "DeWalt" });
  await send("POST", `/api/v1/warranties/${w.id}/claims`, { problem: "Chuck slips", status: "approved" });
  const task = await send("POST", "/api/v1/maintenance", { title: "Oil the chuck", itemId: it.id, dueOn: "2026-01-15", intervalCount: 6, intervalUnit: "month" });
  await send("POST", `/api/v1/maintenance/${task.id}/done`, { doneOn: "2026-01-20", costCents: 2500, note: "Light oil" });
  await send("POST", `/api/v1/items/${it.id}/repairs`, { repairedOn: "2026-02-01", work: "Replaced the chuck", costCents: 4500 });
  const zip = new Uint8Array(await (await ann.as(`/api/v1/items/${it.id}/export.zip`)).arrayBuffer());
  return { ...t, ann, it, zip };
}

const post = async (as: As, url: string, zip: Uint8Array) => as(url, { method: "POST", body: zip as Uint8Array<ArrayBuffer>, headers: { "content-type": "application/zip" } });
const check = async (as: As, zip: Uint8Array) => json<ItemImportCheck>(post(as, "/api/v1/import/item/check", zip));

/** The same ZIP with one file changed (or taken out, with `null`). */
function altered(zip: Uint8Array, path: string, to: Uint8Array | null) {
  const files = unzipSync(zip);
  const name = Object.keys(files).find((n) => n.endsWith(`/${path}`))!;
  if (to) files[name] = to as Uint8Array<ArrayBuffer>;
  else delete files[name];
  return zipSync(files) as Uint8Array;
}

describe("importing a thing exported from Ferret", () => {
  it("says it's signed by this household's key, then adds it with its files, warranties, maintenance and repairs", async () => {
    const { ann, zip } = await exported();
    const seen = await check(ann.as, zip);
    expect(seen).toMatchObject({ name: "Cordless drill", signature: "ours", problems: [], place: "Highland House › Garage", category: null });
    expect(seen.counts).toEqual({ photos: 1, documents: 1, warranties: 1, maintenance: 1, repairs: 1 });
    expect(seen.sameSerial?.name).toBe("Cordless drill");
    const key = await json<SigningKey>(ann.as("/api/v1/household/signing-key"));
    expect(seen.fingerprint).toBe(key.fingerprint);

    const res = await post(ann.as, "/api/v1/import/item", zip);
    expect(res.status).toBe(201);
    const done = (await res.json()) as ItemImportResult;
    expect(done.skippedFiles).toEqual([]);
    const copy = await json<ItemListing>(ann.as(`/api/v1/items/${done.itemId}`));
    expect(copy).toMatchObject({ name: "Cordless drill", brand: "DeWalt", serialNumber: "SN-42", valueCents: 11000, replacementCents: 15000, tags: ["Power tools"], place: "Highland House › Garage", origin: "ferret" });
    const files = await json<{ data: { filename: string; kind: string }[] }>(ann.as(`/api/v1/items/${done.itemId}/attachments`));
    expect(files.data.map((f) => f.filename).sort()).toEqual(["drill.png", "receipt.pdf"]);
    const warranties = await json<{ data: { provider: string; endsOn: string }[] }>(ann.as(`/api/v1/items/${done.itemId}/warranties`));
    expect(warranties.data).toMatchObject([{ provider: "DeWalt", endsOn: "2029-05-01" }]);
    const claims = await json<{ data: { problem: string; status: string }[] }>(ann.as(`/api/v1/claims?itemId=${done.itemId}`));
    expect(claims.data).toMatchObject([{ problem: "Chuck slips", status: "approved" }]);
    const tasks = await json<{ id: string; title: string; dueOn: string }[] | { data: { id: string; title: string }[] }>(ann.as(`/api/v1/maintenance?itemId=${done.itemId}&status=all`));
    const list = Array.isArray(tasks) ? tasks : tasks.data;
    expect(list.map((t) => t.title)).toEqual(["Oil the chuck"]);
    const log = await json<{ data: { doneOn: string; note: string; costCents: number }[] }>(ann.as(`/api/v1/maintenance/${list[0]!.id}/history`));
    expect(log.data).toMatchObject([{ doneOn: "2026-01-20", costCents: 2500 }]);
    expect(log.data[0]!.note).toContain("Light oil");
    const repairs = await json<{ data: { work: string; costCents: number }[] }>(ann.as(`/api/v1/items/${done.itemId}/repairs`));
    expect(repairs.data).toMatchObject([{ work: "Replaced the chuck", costCents: 4500 }]);
    // One import, to undo like any other.
    const imports = await json<{ data: { id: string; source: string }[] }>(ann.as("/api/v1/import"));
    expect(imports.data.find((b) => b.id === done.batchId)?.source).toBe("ferret");
  });

  it("from another household: signed by another key — imported only once the person says so", async () => {
    const { ann, user, zip } = await exported();
    const bob = await user("bob");
    const seen = await check(bob.as, zip);
    const annKey = await json<SigningKey>(ann.as("/api/v1/household/signing-key"));
    expect(seen).toMatchObject({ signature: "other", fingerprint: annKey.fingerprint, propertyId: null, sameSerial: null });
    const refused = await post(bob.as, "/api/v1/import/item", zip);
    expect(refused.status).toBe(409);
    const res = await post(bob.as, "/api/v1/import/item?anyway=true", zip);
    expect(res.status).toBe(201);
    const copy = await json<ItemListing>(bob.as(`/api/v1/items/${((await res.json()) as ItemImportResult).itemId}`));
    // No property of that name here and none chosen: it comes in without a place.
    expect(copy).toMatchObject({ name: "Cordless drill", place: null });
  });

  it("a changed file: says which, and still imports when the person says so", async () => {
    const { ann, zip } = await exported();
    const changed = altered(zip, "Cordless drill.md", strToU8("# Something else"));
    const seen = await check(ann.as, changed);
    expect(seen.signature).toBe("changed");
    expect(seen.problems).toEqual(["Cordless drill.md has changed"]);
    expect((await post(ann.as, "/api/v1/import/item", changed)).status).toBe(409);
    expect((await post(ann.as, "/api/v1/import/item?anyway=true", changed)).status).toBe(201);
  });

  it("a forged item.json with a new SHA256SUMS: the signature no longer holds", async () => {
    const { ann, zip } = await exported();
    const files = unzipSync(zip);
    const root = Object.keys(files).find((n) => n.endsWith("/item.json"))!.slice(0, -"item.json".length);
    const data = JSON.parse(new TextDecoder().decode(files[`${root}item.json`]!));
    data.item.valueCents = 99_999_00;
    files[`${root}item.json`] = strToU8(JSON.stringify(data));
    const hex = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>)), (x) => x.toString(16).padStart(2, "0")).join("");
    const sums = new TextDecoder().decode(files[`${root}SHA256SUMS`]!).trim().split("\n");
    const fixed = await Promise.all(sums.map(async (l) => { const p = l.split("  ")[1]!; return `${await hex(files[root + p]!)}  ${p}`; }));
    files[`${root}SHA256SUMS`] = strToU8(`${fixed.join("\n")}\n`);
    const seen = await check(ann.as, zipSync(files));
    expect(seen.signature).toBe("changed");
    expect(seen.problems).toContain("The signature doesn't match SHA256SUMS");
  });

  it("a doctored item.json imported anyway: fields an edit wouldn't take are left out", async () => {
    const { ann, zip } = await exported();
    const files = unzipSync(zip);
    const name = Object.keys(files).find((n) => n.endsWith("/item.json"))!;
    const data = JSON.parse(new TextDecoder().decode(files[name]!));
    data.item.links = [{ label: "Manual", url: "javascript:alert(1)" }];
    data.item.customFields = "not an object of fields";
    data.item.disposition = "vaporised";
    data.item.disposedOn = "2026-01-01";
    files[name] = strToU8(JSON.stringify(data));
    const res = await post(ann.as, "/api/v1/import/item?anyway=true", zipSync(files));
    expect(res.status).toBe(201);
    const copy = await json<ItemListing & { links: unknown[] | null; disposition: string | null }>(ann.as(`/api/v1/items/${((await res.json()) as ItemImportResult).itemId}`));
    expect(copy).toMatchObject({ name: "Cordless drill", serialNumber: "SN-42", replacementCents: 15000, disposition: null });
    expect(copy.links ?? []).toEqual([]);
  });

  it("without its signature: unsigned", async () => {
    const { ann, zip } = await exported();
    const seen = await check(ann.as, altered(zip, "SHA256SUMS.sig", null));
    expect(seen).toMatchObject({ signature: "unsigned", fingerprint: null });
  });

  it("refuses what isn't a Ferret export", async () => {
    const { ann } = await exported();
    expect((await post(ann.as, "/api/v1/import/item/check", strToU8("not a zip"))).status).toBe(422);
    expect((await post(ann.as, "/api/v1/import/item/check", zipSync({ "notes/readme.txt": strToU8("hi") }))).status).toBe(422);
    expect((await post(ann.as, "/api/v1/import/item/check", zipSync({ "x/item.json": strToU8(JSON.stringify({ format: "ferret-item", version: 9, item: { name: "x" } })) }))).status).toBe(422);
  });
});
