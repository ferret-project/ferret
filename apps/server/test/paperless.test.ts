/** Paperless-ngx as a source (lib/paperless.ts): connect, sync the tagged documents into an inbox, sort them. */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { member, paperlessConnection, user as userTable } from "../src/db/schema";
import { PAPERLESS_SYNC_JOB } from "../src/lib/paperless";
import { type Paperless, type PaperlessDoc, PaperlessError, type PaperlessServer } from "../src/ports";
import { pdf, setup } from "./helpers";

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const TOKEN = "0123456789abcdef0123456789abcdef01234567";

class FakePaperless implements Paperless {
  docs: PaperlessDoc[] = [];
  tags = [{ id: 7, name: "Ferret" }];
  people = new Map([[3, "Home Depot"]]);
  token = TOKEN;
  down: string | null = null;
  calls: { what: string; server: PaperlessServer }[] = [];
  private check(server: PaperlessServer, what: string) {
    this.calls.push({ what, server });
    if (this.down) throw new PaperlessError(this.down);
    if (server.token !== this.token) throw new PaperlessError("Paperless refused the token", 401);
  }
  async whoAmI(server: PaperlessServer) {
    this.check(server, "whoAmI");
    return { user: "ferret" };
  }
  async findTag(server: PaperlessServer, name: string) {
    this.check(server, "findTag");
    return this.tags.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null;
  }
  async documents(server: PaperlessServer, q: { tagId?: number; query?: string; page?: number; pageSize?: number }) {
    this.check(server, "documents");
    let list = [...this.docs].sort((a, b) => b.id - a.id);
    if (q.tagId !== undefined) list = list.filter((d) => d.tags.includes(q.tagId!));
    if (q.query?.startsWith("id:")) list = list.filter((d) => d.id === Number(q.query!.slice(3)));
    else if (q.query) list = list.filter((d) => `${d.title} ${d.content}`.toLowerCase().includes(q.query!.toLowerCase()));
    const size = q.pageSize ?? 50;
    const page = q.page ?? 1;
    return { count: list.length, more: list.length > page * size, results: list.slice((page - 1) * size, page * size) };
  }
  async correspondents(server: PaperlessServer, ids: number[]) {
    this.check(server, "correspondents");
    return new Map(ids.flatMap((id) => (this.people.has(id) ? [[id, this.people.get(id)!] as const] : [])));
  }
  async download(server: PaperlessServer, id: number) {
    this.check(server, "download");
    const d = this.docs.find((x) => x.id === id);
    if (!d) throw new PaperlessError("Paperless doesn't have that", 404);
    return d.mimeType?.startsWith("text/")
      ? { bytes: new TextEncoder().encode(d.content), filename: `${d.title}.txt`, contentType: "text/plain" }
      : { bytes: pdf(d.content), filename: `${d.title}.pdf`, contentType: "application/pdf" };
  }
  async thumbnail(server: PaperlessServer, id: number) {
    this.check(server, "thumbnail");
    if (!this.docs.some((d) => d.id === id)) throw new PaperlessError("Paperless doesn't have that", 404);
    return { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), contentType: "image/webp" };
  }
}

const doc = (id: number, title: string, extra: Partial<PaperlessDoc> = {}): PaperlessDoc => ({
  id,
  title,
  correspondent: null,
  created: "2026-11-15",
  mimeType: "application/pdf",
  content: `${title} receipt total $99.00`,
  tags: [7],
  ...extra,
});

const connection = { url: "https://paperless.example.com/", token: TOKEN, tag: "ferret", copyFiles: true };

describe("Paperless-ngx", () => {
  it("connects after checking the token and the tag, keeps the token sealed, and fills the inbox from the tagged documents", async () => {
    const paperless = new FakePaperless();
    paperless.docs = [doc(1, "Drill receipt", { correspondent: 3 }), doc(2, "Tax letter", { tags: [9] }), doc(3, "Fridge manual")];
    const { user, jobs, db } = await setup({ paperless });
    const ann = await user("ann");

    expect(await json(ann.as("/api/v1/paperless"))).toMatchObject({ available: true, local: true, connection: null });
    // A wrong token, a missing tag: said now, nothing kept.
    const wrong = await ann.as("/api/v1/paperless", { method: "PUT", body: JSON.stringify({ ...connection, token: "x".repeat(40) }) });
    expect(wrong.status).toBe(400);
    expect((await json<{ error: { message: string } }>(wrong)).error.message).toContain("refused the token");
    const noTag = await ann.as("/api/v1/paperless", { method: "PUT", body: JSON.stringify({ ...connection, tag: "inventory" }) });
    expect((await json<{ error: { message: string } }>(noTag)).error.message).toContain('no tag called "inventory"');
    expect(await db.select().from(paperlessConnection)).toHaveLength(0);

    const made = await ann.as("/api/v1/paperless", { method: "PUT", body: JSON.stringify(connection) });
    expect(made.status).toBe(200);
    expect(await json(made)).toMatchObject({ url: "https://paperless.example.com", host: "paperless.example.com", tag: "Ferret", user: "ferret", copyFiles: true });
    const [row] = await db.select().from(paperlessConnection);
    expect(row!.tokenSealed).not.toContain(TOKEN);
    expect(JSON.stringify(await json(ann.as("/api/v1/paperless")))).not.toContain(TOKEN);

    await jobs.drain(); // the first sync
    const inbox = await json<{ connected: boolean; data: { id: number; title: string; correspondent: string | null; url: string; status: string }[] }>(ann.as("/api/v1/paperless/documents"));
    expect(inbox.connected).toBe(true);
    expect(inbox.data.map((d) => d.title).sort()).toEqual(["Drill receipt", "Fridge manual"]); // not the untagged letter
    expect(inbox.data.find((d) => d.id === 1)).toMatchObject({ correspondent: "Home Depot", url: "https://paperless.example.com/documents/1/details", status: "new" });

    // Again: nothing twice; a new one comes in.
    paperless.docs.push(doc(4, "Mower receipt"));
    const sync = await json<{ added: number }>(ann.as("/api/v1/paperless/sync", { method: "POST" }));
    expect(sync.added).toBe(1);
    expect((await json<{ data: unknown[] }>(ann.as("/api/v1/paperless/documents"))).data).toHaveLength(3);

    // The bell says so.
    const bell = await json<{ data: { kind: string; title: string; href?: string }[] }>(ann.as("/api/v1/attention"));
    expect(bell.data.find((a) => a.kind === "paperless")).toMatchObject({ title: "3 documents from Paperless to sort", href: "#/paperless" });
  });

  it("adds a document as a new thing, or attaches it to one — the file copied in and a link back — and dismisses", async () => {
    const paperless = new FakePaperless();
    paperless.docs = [doc(1, "DeWalt drill receipt"), doc(2, "Fridge manual"), doc(3, "Junk mail"), doc(5, "Plain note", { mimeType: "text/plain", content: "just words" })];
    const { user, jobs } = await setup({ paperless });
    const ann = await user("ann");
    const fridge = await ann.addItem({ name: "Fridge", brand: "LG" });
    await ann.as("/api/v1/paperless", { method: "PUT", body: JSON.stringify(connection) });
    await jobs.drain();

    // A match is offered for the fridge's manual.
    const inbox = await json<{ data: { id: number; match: { id: string } | null }[] }>(ann.as("/api/v1/paperless/documents"));
    expect(inbox.data.find((d) => d.id === 2)!.match).toMatchObject({ id: fridge.id });

    const added = await ann.as("/api/v1/paperless/documents/1/add", { method: "POST", body: JSON.stringify({}) });
    expect(added.status).toBe(201);
    const a = await json<{ item: { id: string; name: string }; copied: boolean }>(added);
    expect(a).toMatchObject({ item: { name: "DeWalt drill receipt" }, copied: true });
    const thing = await json<{ origin: string; originDetail: string; links: { url: string; label: string }[] }>(ann.as(`/api/v1/items/${a.item.id}`));
    expect(thing).toMatchObject({ origin: "paperless", originDetail: "DeWalt drill receipt", links: [{ url: "https://paperless.example.com/documents/1/details", label: "Paperless: DeWalt drill receipt" }] });
    const files = await ann.attachments(a.item.id);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ kind: "document", filename: "DeWalt drill receipt.pdf" });
    expect((await ann.as(`/api/v1/paperless/documents/1/add`, { method: "POST", body: "{}" })).status).toBe(409);

    const attached = await json<{ item: { id: string }; copied: boolean }>(ann.as("/api/v1/paperless/documents/2/attach", { method: "POST", body: JSON.stringify({ itemId: fridge.id }) }));
    expect(attached).toMatchObject({ item: { id: fridge.id }, copied: true });
    expect(await ann.attachments(fridge.id)).toHaveLength(1);

    // Plain text can only be linked.
    const note = await json<{ copied: boolean; note: string }>(ann.as("/api/v1/paperless/documents/5/attach", { method: "POST", body: JSON.stringify({ itemId: fridge.id }) }));
    expect(note).toMatchObject({ copied: false, note: "Paperless only has its text — linked instead" });
    expect((await json<{ links: unknown[] }>(ann.as(`/api/v1/items/${fridge.id}`))).links).toHaveLength(2);

    expect((await ann.as("/api/v1/paperless/documents/3/dismiss", { method: "POST" })).status).toBe(204);
    expect((await json<{ data: unknown[] }>(ann.as("/api/v1/paperless/documents"))).data).toHaveLength(0);
    const done = await json<{ data: { id: number; status: string; item: { name: string } | null }[] }>(ann.as("/api/v1/paperless/documents?status=done"));
    expect(done.data.map((d) => [d.id, d.status]).sort()).toEqual([[1, "added"], [2, "attached"], [3, "dismissed"], [5, "attached"]]);
    expect((await ann.as("/api/v1/paperless/documents/3/restore", { method: "POST" })).status).toBe(204);
    expect((await json<{ data: { id: number }[] }>(ann.as("/api/v1/paperless/documents"))).data.map((d) => d.id)).toEqual([3]);

    // A search of Paperless finds any document; attaching one from there works too.
    paperless.docs.push(doc(9, "Fridge warranty card", { tags: [] }));
    const found = await json<{ data: { id: number; status: string }[] }>(ann.as("/api/v1/paperless/search?q=warranty"));
    expect(found.data).toMatchObject([{ id: 9, status: "new" }]);
    expect((await ann.as("/api/v1/paperless/documents/9/attach", { method: "POST", body: JSON.stringify({ itemId: fridge.id }) })).status).toBe(200);
    expect((await ann.as("/api/v1/paperless/documents/9/thumbnail")).headers.get("content-type")).toBe("image/webp");
  });

  it("links only when the household chose so", async () => {
    const paperless = new FakePaperless();
    paperless.docs = [doc(1, "Drill receipt")];
    const { user, jobs } = await setup({ paperless });
    const ann = await user("ann");
    await ann.as("/api/v1/paperless", { method: "PUT", body: JSON.stringify({ ...connection, copyFiles: false }) });
    await jobs.drain();
    const a = await json<{ item: { id: string }; copied: boolean; note: string | null }>(ann.as("/api/v1/paperless/documents/1/add", { method: "POST", body: "{}" }));
    expect(a).toMatchObject({ copied: false, note: null });
    expect(await ann.attachments(a.item.id)).toHaveLength(0);
    expect(paperless.calls.some((c) => c.what === "download")).toBe(false);
  });

  it("keeps a failing sync on the connection (the bell after a day), and recovers", async () => {
    const paperless = new FakePaperless();
    const { user, jobs, db } = await setup({ paperless });
    const ann = await user("ann");
    await ann.as("/api/v1/paperless", { method: "PUT", body: JSON.stringify(connection) });
    await jobs.drain();
    paperless.down = "Couldn't reach paperless.example.com (nothing is listening there)";
    await jobs.enqueue(PAPERLESS_SYNC_JOB, { householdId: ann.householdId });
    await jobs.drain();
    expect(await json(ann.as("/api/v1/paperless"))).toMatchObject({ connection: { lastError: paperless.down } });
    let bell = await json<{ data: { id: string }[] }>(ann.as("/api/v1/attention"));
    expect(bell.data.some((a) => a.id === "paperless-trouble")).toBe(false); // not yet a day
    await db.update(paperlessConnection).set({ failingSince: new Date(Date.now() - 25 * 3600_000) });
    bell = await json<{ data: { id: string; detail: string }[] }>(ann.as("/api/v1/attention"));
    expect(bell.data.find((a) => a.id === "paperless-trouble")).toMatchObject({ detail: paperless.down });

    paperless.down = null;
    await ann.as("/api/v1/paperless/sync", { method: "POST" });
    expect(await json(ann.as("/api/v1/paperless"))).toMatchObject({ connection: { lastError: null } });
  });

  it("is for owners and admins to connect, writers to sort, and anyone in the household to look at", async () => {
    const paperless = new FakePaperless();
    paperless.docs = [doc(1, "Drill receipt")];
    const { user, jobs, db } = await setup({ paperless });
    const ann = await user("ann");
    const val = await user("val");
    const mo = await user("mo");
    await ann.as("/api/v1/paperless", { method: "PUT", body: JSON.stringify(connection) });
    await jobs.drain();
    const idOf = async (name: string) => (await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.name, name)))[0]!.id;
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: await idOf("val"), role: "viewer", createdAt: new Date() });
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: ann.householdId, userId: await idOf("mo"), role: "member", createdAt: new Date() });
    const inAnns = { "X-Household-Id": ann.householdId };

    expect((await json<{ data: unknown[] }>(val.as("/api/v1/paperless/documents", { headers: inAnns }))).data).toHaveLength(1);
    expect((await val.as("/api/v1/paperless/documents/1/add", { method: "POST", body: "{}", headers: inAnns })).status).toBe(403);
    expect((await mo.as("/api/v1/paperless", { method: "PUT", body: JSON.stringify(connection), headers: inAnns })).status).toBe(403);
    expect((await mo.as("/api/v1/paperless", { method: "DELETE", headers: inAnns })).status).toBe(403);
    expect((await mo.as("/api/v1/paperless/documents/1/add", { method: "POST", body: "{}", headers: inAnns })).status).toBe(201);
    // Nothing of ann's Paperless is anyone else's: mo's own household has none.
    expect(await json(mo.as("/api/v1/paperless/documents"))).toEqual({ connected: false, data: [] });

    // Only the server admin may point it at the server's own network.
    const local = await mo.as("/api/v1/paperless", { method: "PUT", body: JSON.stringify({ ...connection, url: "http://192.168.1.20:8000" }) });
    expect(local.status).toBe(403);

    // Disconnecting drops the token and the inbox; copied files stay.
    expect((await ann.as("/api/v1/paperless", { method: "DELETE" })).status).toBe(204);
    expect(await db.select().from(paperlessConnection)).toHaveLength(0);
    expect(await json(ann.as("/api/v1/paperless/documents"))).toEqual({ connected: false, data: [] });
  });

  it("lets Claude read the inbox and sort it (a read-only key only reads)", async () => {
    const paperless = new FakePaperless();
    paperless.docs = [doc(1, "Fridge manual"), doc(2, "Junk mail"), doc(3, "Kettle receipt")];
    const { app, user, jobs } = await setup({ paperless });
    const ann = await user("ann");
    const fridge = await ann.addItem({ name: "Fridge" });
    await ann.as("/api/v1/paperless", { method: "PUT", body: JSON.stringify(connection) });
    await jobs.drain();
    const keyOf = async (readOnly: boolean) => (await json<{ key: string }>(ann.as("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "Claude", readOnly }) }))).key;
    const connect = async (key: string) => {
      const transport = new StreamableHTTPClientTransport(new URL("http://ferret.test/mcp"), {
        fetch: async (url, init) => app.request(String(url), init),
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      });
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(transport);
      return async (name: string, args: Record<string, unknown> = {}) => {
        const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
        return { isError: Boolean(r.isError), json: () => JSON.parse(r.content[0]!.text) };
      };
    };
    const call = await connect(await keyOf(false));
    const inbox = (await call("paperless_inbox")).json();
    expect(inbox.connected).toBe(true);
    expect(inbox.documents.find((d: { documentId: number }) => d.documentId === 1)).toMatchObject({ title: "Fridge manual", maybeFor: { id: fridge.id, name: "Fridge" }, status: "new" });

    expect((await call("sort_paperless_document", { documentId: 1, action: "attach", itemId: fridge.id })).json()).toMatchObject({ item: { id: fridge.id }, copied: true });
    expect((await call("sort_paperless_document", { documentId: 2, action: "dismiss" })).json()).toEqual({ ok: true });
    const kettle = (await call("sort_paperless_document", { documentId: 3, action: "add", name: "Kettle" })).json();
    expect(kettle).toMatchObject({ item: { name: "Kettle" }, copied: true });
    expect((await call("sort_paperless_document", { documentId: 1, action: "attach" })).isError).toBe(true); // no itemId
    expect((await call("paperless_inbox")).json().documents).toEqual([]);
    expect((await call("paperless_inbox", { sorted: true })).json().documents).toHaveLength(3);
    expect((await call("paperless_inbox", { query: "kettle" })).json().documents).toMatchObject([{ documentId: 3, status: "added", thing: { name: "Kettle" } }]);

    const reader = await connect(await keyOf(true));
    expect((await reader("paperless_inbox")).isError).toBe(false);
    await expect(reader("sort_paperless_document", { documentId: 2, action: "restore" })).rejects.toThrow(/not found/); // not offered
  });

  it("is hidden on a server without it", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    expect(await json(ann.as("/api/v1/paperless"))).toMatchObject({ available: false, connection: null });
    expect((await ann.as("/api/v1/paperless", { method: "PUT", body: JSON.stringify(connection) })).status).toBe(409);
  });
});
