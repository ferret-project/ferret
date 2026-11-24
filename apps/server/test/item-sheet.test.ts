/** One thing's sheet and its signed export: everything about it, the parts asked for, a signature anyone can check. */
import type { ItemSheet, SigningKey } from "@ferret/shared";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { pdf, setup } from "./helpers";

const PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("drill photo")]);
const RECEIPT = pdf("DeWalt receipt $129.00");
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function drill() {
  const t = await setup();
  const ann = await t.user("ann");
  const send = <T = { id: string }>(method: string, url: string, body?: object) => json<T>(ann.as(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const it = await ann.addItem({ name: "Cordless drill", brand: "DeWalt", serialNumber: "SN-42", notes: "Alarm code 1234", purchasePriceCents: 12900, tags: ["Power tools"] });
  await ann.upload(it.id, PHOTO, "drill.png");
  await ann.upload(it.id, RECEIPT, "receipt.pdf", "document");
  const w = await send("POST", `/api/v1/items/${it.id}/warranties`, { endsOn: "2029-05-01", provider: "DeWalt", coverage: "Parts and labour" });
  await send("POST", `/api/v1/warranties/${w.id}/claims`, { problem: "Chuck slips" });
  const task = await send("POST", "/api/v1/maintenance", { title: "Oil the chuck", itemId: it.id, dueOn: "2026-01-15", intervalCount: 6, intervalUnit: "month" });
  await send("POST", `/api/v1/maintenance/${task.id}/done`, { doneOn: "2026-01-20", costCents: 2500 });
  return { ...t, ann, it };
}

/** Checks an OpenSSH signature (SSHSIG) of `message` against the Ed25519 key inside it; returns that key's blob. */
async function verifySshSig(armoured: string, message: Uint8Array, namespace: string) {
  const b64 = armoured.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const blob = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  let at = 0;
  const take = (n: number) => blob.subarray(at, (at += n));
  const str = () => take(new DataView(blob.buffer, blob.byteOffset + at).getUint32(0) + 4).subarray(4);
  expect(text(take(6))).toBe("SSHSIG");
  take(4); // version
  const pub = str();
  expect(text(str())).toBe(namespace);
  str(); // reserved
  expect(text(str())).toBe("sha512");
  const sigBlob = str();
  // The public key's and the signature's own fields: string type, string bytes.
  const field = (b: Uint8Array, i: number) => {
    let p = 0;
    let out = b;
    for (let k = 0; k <= i; k++) {
      const len = new DataView(b.buffer, b.byteOffset + p).getUint32(0);
      out = b.subarray(p + 4, p + 4 + len);
      p += 4 + len;
    }
    return out;
  };
  const raw = field(pub, 1);
  const sig = field(sigBlob, 1);
  const enc = new TextEncoder();
  const s = (d: Uint8Array) => {
    const out = new Uint8Array(4 + d.length);
    new DataView(out.buffer).setUint32(0, d.length);
    out.set(d, 4);
    return out;
  };
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-512", message as Uint8Array<ArrayBuffer>));
  const signed = new Uint8Array([...enc.encode("SSHSIG"), ...s(enc.encode(namespace)), ...s(new Uint8Array()), ...s(enc.encode("sha512")), ...s(hash)]);
  const key = await crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["verify"]);
  expect(await crypto.subtle.verify({ name: "Ed25519" }, key, sig as Uint8Array<ArrayBuffer>, signed)).toBe(true);
  return pub;
}

describe("a thing's sheet", () => {
  it("writes out its details, warranties with claims, maintenance with what was done, photos and documents", async () => {
    const { ann, it: drillItem } = await drill();
    const sheet = await json<ItemSheet>(ann.as(`/api/v1/items/${drillItem.id}/sheet`));
    expect(sheet.name).toBe("Cordless drill");
    const details = sheet.sections.find((s) => s.id === "details")!;
    expect(details.rows).toContainEqual(["Serial number", "SN-42"]);
    expect(details.rows?.find(([l]) => l === "Bought")?.[1]).toContain("$129.00");
    expect(sheet.sections.find((s) => s.id === "notes")?.text).toBe("Alarm code 1234");
    const warranty = sheet.sections.find((s) => s.id === "warranties")!.entries![0]!;
    expect(warranty.title).toBe("DeWalt");
    expect(warranty.lines?.[0]).toContain("Chuck slips");
    const task = sheet.sections.find((s) => s.id === "maintenance")!.entries![0]!;
    expect(task.rows).toContainEqual(["How often", "every 6 months"]);
    expect(task.lines?.[0]).toContain("$25.00");
    expect(sheet.photos.map((p) => p.filename)).toEqual(["drill.png"]);
    expect(sheet.documents.map((d) => d.filename)).toEqual(["receipt.pdf"]);
    expect(sheet.sections.some((s) => s.id === "history")).toBe(true);
  });

  it("leaves out the parts not asked for, keeping the details", async () => {
    const { ann, it: drillItem } = await drill();
    const sheet = await json<ItemSheet>(ann.as(`/api/v1/items/${drillItem.id}/sheet?parts=warranties`));
    expect(sheet.sections.map((s) => s.id)).toEqual(["details", "warranties"]);
    expect(sheet.photos).toEqual([]);
    expect(sheet.documents).toEqual([]);
  });

  it("is only for its own household", async () => {
    const { user, it: drillItem } = await drill();
    const bob = await user("bob");
    expect((await bob.as(`/api/v1/items/${drillItem.id}/sheet`)).status).toBe(404);
    expect((await bob.as(`/api/v1/items/${drillItem.id}/export.zip`)).status).toBe(404);
  });
});

describe("a thing's export", () => {
  it("holds the Markdown, item.json and the files, with SHA256SUMS signed by the household's key", async () => {
    const { ann, it: drillItem } = await drill();
    const res = await ann.as(`/api/v1/items/${drillItem.id}/export.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("Cordless drill.zip");
    const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const at = (name: string) => zip[`Cordless drill/${name}`]!;
    expect(Object.keys(zip).sort()).toEqual(
      ["Cordless drill.md", "SHA256SUMS", "SHA256SUMS.sig", "VERIFY.txt", "allowed_signers", "ferret-signing-key.pub", "files/drill.png", "files/receipt.pdf", "item.json"].map((n) => `Cordless drill/${n}`).sort(),
    );
    const md = text(at("Cordless drill.md"));
    expect(md).toContain("# Cordless drill");
    expect(md).toContain("![");
    expect(md).toContain("(files/drill.png)");
    expect(md).toContain("- **Serial number:** SN-42");
    expect(at("files/drill.png")).toEqual(PHOTO);
    const data = JSON.parse(text(at("item.json")));
    expect(data).toMatchObject({ format: "ferret-item", version: 1, item: { name: "Cordless drill", serialNumber: "SN-42" } });
    expect(data.warranties[0]).toMatchObject({ provider: "DeWalt", endsOn: "2029-05-01" });

    // Every file is in SHA256SUMS with its hash…
    const sums = text(at("SHA256SUMS"));
    for (const line of sums.trim().split("\n")) {
      const [hash, path] = line.split("  ");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", at(path!) as Uint8Array<ArrayBuffer>));
      expect(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")).toBe(hash);
    }
    expect(sums.split("\n").filter(Boolean)).toHaveLength(4);
    // …and SHA256SUMS is signed with the key Settings shows.
    const key = await json<SigningKey>(ann.as("/api/v1/household/signing-key"));
    const pub = await verifySshSig(text(at("SHA256SUMS.sig")), at("SHA256SUMS"), key.namespace);
    expect(key.publicKey.split(" ")[1]).toBe(btoa(String.fromCharCode(...pub)));
    expect(text(at("allowed_signers")).trim()).toBe(key.allowedSigners);
    expect(text(at("VERIFY.txt"))).toContain(key.fingerprint);
    expect(text(at("ferret-signing-key.pub")).trim()).toBe(key.publicKey);
  });

  it("keeps the same key from one export to the next", async () => {
    const { ann } = await drill();
    const first = await json<SigningKey>(ann.as("/api/v1/household/signing-key"));
    const again = await json<SigningKey>(ann.as("/api/v1/household/signing-key"));
    expect(again).toEqual(first);
    expect(first.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(first.allowedSigners).toBe(`ferret namespaces="ferret-export" ${first.publicKey.split(" ").slice(0, 2).join(" ")}`);
  });

  it("leaves out unticked parts: no photos, no notes", async () => {
    const { ann, it: drillItem } = await drill();
    const zip = unzipSync(new Uint8Array(await (await ann.as(`/api/v1/items/${drillItem.id}/export.zip?parts=documents`)).arrayBuffer()));
    const names = Object.keys(zip);
    expect(names).toContain("Cordless drill/files/receipt.pdf");
    expect(names).not.toContain("Cordless drill/files/drill.png");
    expect(text(zip["Cordless drill/Cordless drill.md"]!)).not.toContain("Alarm code");
    expect(JSON.parse(text(zip["Cordless drill/item.json"]!)).item.notes).toBeNull();
  });

  it("needs a real sign-in, not an API key", async () => {
    const { ann, it: drillItem } = await drill();
    const key = await json<{ key: string }>(ann.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "script" }) }));
    const res = await ann.as(`/api/v1/items/${drillItem.id}/export.zip`, { headers: { Cookie: "", Authorization: `Bearer ${key.key}` } });
    expect(res.status).toBe(403);
  });
});
