/** Signed backups: every manifest carries its files' hashes and is signed with the server's key, checkable without FILES_KEY. */
import type { SigningKey } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { supportsSnapshots } from "./db";
import { type Backups, checkSnapshot, listSnapshots, readManifest, runBackup } from "../src/lib/backup";
import { BACKUP_NAMESPACE, serverSigningKey, verifySignature } from "../src/lib/signing";
import { config, photo, setup } from "./helpers";

const hex = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>)), (x) => x.toString(16).padStart(2, "0")).join("");
const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function backedUp() {
  const t = await setup({ backups: true });
  const ann = await t.user("ann");
  const drill = await ann.addItem({ name: "Cordless drill" });
  await ann.upload(drill.id, await photo(), "drill.jpg");
  const b: Backups = { db: t.db, blobs: t.deps.blobs, ...t.deps.backups!, filesKey: config.FILES_KEY, keep: 14 };
  await runBackup(b);
  const target = t.deps.backups!.target;
  const [name] = await listSnapshots(target);
  return { ...t, ann, b, target, name: name! };
}

describe.skipIf(!supportsSnapshots)("signed backups", () => {
  it("hashes the copy and every file, signs the manifest, and leaves the public key beside them", async () => {
    const { b, target, name } = await backedUp();
    const manifest = await readManifest(target, name);
    expect(manifest.dbEncSha256).toBe(await hex((await target.get(`snapshots/${name}.db.enc`))!));
    for (const f of manifest.files) expect(f.sha256).toBe(await hex((await target.get(`files/${f.key}`))!));

    const key: SigningKey = await serverSigningKey(b.db, b.filesKey);
    expect(key.namespace).toBe("ferret-backup");
    expect(text((await target.get("signing-key.pub"))!).trim()).toBe(key.publicKey);
    expect(text((await target.get("allowed_signers"))!).trim()).toBe(key.allowedSigners);
    const signed = await verifySignature(text((await target.get(`snapshots/${name}.json.sig`))!), (await target.get(`snapshots/${name}.json`))!, BACKUP_NAMESPACE);
    expect(signed?.fingerprint).toBe(key.fingerprint);
  });

  it("keeps one key, and the next backup carries the hashes of files it didn't copy again", async () => {
    const { b, target } = await backedUp();
    const first = await serverSigningKey(b.db, b.filesKey);
    await runBackup(b, new Date(Date.now() + 86_400_000));
    const [newest] = await listSnapshots(target);
    const manifest = await readManifest(target, newest!);
    expect(manifest.files.every((f) => f.sha256)).toBe(true);
    expect(await serverSigningKey(b.db, b.filesKey)).toEqual(first);
  });

  it("the check fails when the manifest or the database copy was changed", async () => {
    const { b, target, name } = await backedUp();
    const manifest = (await target.get(`snapshots/${name}.json`))!;
    expect((await checkSnapshot(b, name)).summary).toContain("signature good");

    const edited = JSON.parse(text(manifest));
    edited.counts.items = 999;
    await target.put(`snapshots/${name}.json`, new TextEncoder().encode(JSON.stringify(edited, null, 1)));
    await expect(checkSnapshot(b, name)).rejects.toThrow(/signature/);
    await target.put(`snapshots/${name}.json`, manifest);

    const sealed = (await target.get(`snapshots/${name}.db.enc`))!;
    const flipped = new Uint8Array(sealed);
    flipped[flipped.length - 1]! ^= 1;
    await target.put(`snapshots/${name}.db.enc`, flipped);
    await expect(checkSnapshot(b, name)).rejects.toThrow(/doesn't match/);
  });
});
