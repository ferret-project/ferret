/**
 * A backup made once and kept in the repo (test/fixtures/backup-v1) must always restore: with today's code, migrated
 * to today's schema, and usable — sign in as its owner and read the items, warranty, maintenance and files back.
 * If this fails, a change broke old backups (the format, the encryption, or a migration).
 *
 * The fixture was made with the test FILES_KEY (helpers.ts). Never regenerate it to make this pass — only add a
 * newer one (backup-v2…) when the format changes on purpose, and keep the old ones restoring:
 *   MAKE_BACKUP_FIXTURE=1 pnpm --filter @ferret/server exec vitest run test/backup-fixture.test.ts
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FolderBackupTarget, SqliteSnapshots } from "../src/adapters/local/backup";
import { FsBlobs } from "../src/adapters/local/blobs";
import { createLocalDb, runMigrations } from "../src/adapters/local/db";
import { restoreBackup } from "../src/adapters/local/restore";
import { createApp } from "../src/app";
import { checkSnapshot, listSnapshots, runBackup } from "../src/lib/backup";
import { PASSWORD, config, pdf, setup } from "./helpers";

const FIXTURE = path.resolve(__dirname, "fixtures/backup-v1");
const MIGRATIONS = path.resolve(__dirname, "../migrations");
/** A tiny "photo": a PNG signature and some bytes (no thumbnail can be made of it, which is fine). */
const PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("drill photo")]);
const RECEIPT = pdf("Home Depot receipt: DeWalt DCD777 $129.00");
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

describe("backup fixture", () => {
  it.runIf(process.env.MAKE_BACKUP_FIXTURE)("makes test/fixtures/backup-v1", async () => {
    if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true });
    const t = await setup();
    const ann = await t.user("ann");
    const send = (method: string, url: string, body: object) => json<{ id: string }>(ann.as(url, { method, body: JSON.stringify(body) }));
    const house = await send("POST", "/api/v1/properties", { name: "Highland House" });
    const garage = await send("POST", "/api/v1/locations", { propertyId: house.id, name: "Garage" });
    const drill = await ann.addItem({ name: "Cordless drill", brand: "DeWalt", model: "DCD777", serialNumber: "SN-12345", locationId: garage.id, purchasePriceCents: 12900 });
    await ann.upload(drill.id, PHOTO, "drill.png");
    await ann.upload(drill.id, RECEIPT, "receipt.pdf", "document");
    await send("POST", `/api/v1/items/${drill.id}/warranties`, { endsOn: "2029-05-01", provider: "DeWalt" });
    await send("POST", "/api/v1/maintenance", { title: "Oil the chuck", itemId: drill.id, dueOn: "2027-01-15" });

    const target = new FolderBackupTarget(FIXTURE);
    await runBackup({ db: t.db, blobs: t.deps.blobs, snapshots: new SqliteSnapshots(t.db), target, filesKey: config.FILES_KEY, keep: 1 }, new Date("2026-10-18T12:00:00Z"));
    expect(await listSnapshots(target)).toEqual(["ferret-20261018T120000Z"]);
  });

  it("restores, migrates and serves a backup made by an earlier version", async () => {
    // Work on a copy: the check and restore only read, but keep the fixture untouchable anyway.
    const work = mkdtempSync(path.join(tmpdir(), "ferret-fixture-"));
    cpSync(FIXTURE, path.join(work, "backup"), { recursive: true });
    const target = new FolderBackupTarget(path.join(work, "backup"));
    const [name] = await listSnapshots(target);
    expect(name).toBe("ferret-20261018T120000Z");

    const { summary } = await checkSnapshot({ snapshots: new SqliteSnapshots(createLocalDb(":memory:").db), target, filesKey: config.FILES_KEY }, name!);
    expect(summary).toBe("Opened the copy: 1 item, 2 files, all there; 2 decrypted");

    // Restore it into an empty data folder, then start the app on it as the server would: migrations first.
    const dataDir = path.join(work, "data");
    await restoreBackup({ target, filesKey: config.FILES_KEY, dataDir });
    const { db, client } = createLocalDb(`file:${path.join(dataDir, "ferret.db")}`);
    try {
      await runMigrations(db, MIGRATIONS);
      const { app } = createApp({ db, blobs: new FsBlobs(path.join(dataDir, "files")) }, { ...config, ALLOW_SIGNUP: false });

      const signIn = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: config.PUBLIC_URL },
        body: JSON.stringify({ email: "ann@example.com", password: PASSWORD }),
      });
      expect(signIn.status).toBe(200);
      const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const plain = (url: string, headers: Record<string, string> = {}) => app.request(url, { headers: { Cookie: cookie, Origin: config.PUBLIC_URL, ...headers } });
      const [home] = await json<{ id: string; name: string }[]>(plain("/api/auth/organization/list"));
      expect(home).toMatchObject({ name: "ann home" });
      const as = (url: string) => plain(url, { "X-Household-Id": home!.id });

      const items = await json<{ data: { id: string; name: string; brand: string; serialNumber: string; place: string | null }[] }>(as("/api/v1/items"));
      expect(items.data).toEqual([
        expect.objectContaining({ name: "Cordless drill", brand: "DeWalt", serialNumber: "SN-12345", place: "Highland House › Garage" }),
      ]);
      const drill = items.data[0]!;
      expect((await json<{ data: unknown[] }>(as(`/api/v1/items/${drill.id}/warranties`))).data).toEqual([expect.objectContaining({ endsOn: "2029-05-01", provider: "DeWalt" })]);
      expect((await json<{ data: unknown[] }>(as("/api/v1/maintenance"))).data).toEqual([expect.objectContaining({ title: "Oil the chuck", dueOn: "2027-01-15" })]);
      // Keyword search works on the restored copy too.
      expect((await json<{ data: { name: string }[] }>(as("/api/v1/items?q=dewalt"))).data.map((i) => i.name)).toEqual(["Cordless drill"]);

      // The files decrypt, byte for byte, with the household key restored from the backup.
      const files = await json<{ data: { id: string; filename: string }[] }>(as(`/api/v1/items/${drill.id}/attachments`));
      const byName = Object.fromEntries(files.data.map((f) => [f.filename, f.id]));
      const content = async (id: string) => new Uint8Array(await (await as(`/api/v1/attachments/${id}/content`)).arrayBuffer());
      expect(await content(byName["drill.png"]!)).toEqual(PHOTO);
      expect(await content(byName["receipt.pdf"]!)).toEqual(RECEIPT);
    } finally {
      client.close();
      rmSync(work, { recursive: true });
    }
  });
});
