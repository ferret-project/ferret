/** Hardcover: connected by a code (OAuth device grant), asked with Open Library, its sign-in renewed and lost. */
import type { BarcodeMatch, HardcoverStatus, ProductInfo } from "@ferret/shared";
import { describe, expect, it } from "vitest";
import { HardcoverApi, toBook } from "../src/adapters/local/hardcover";
import { hardcoverToken } from "../src/lib/hardcover";
import type { Db, ProductLookup } from "../src/ports";
import { config, setup } from "./helpers";

type User = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["user"]>>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const send = (u: User, method: string, url: string, data?: object) => u.as(url, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
const scan = (u: User, code: string) => json<{ match: BarcodeMatch | null }>(u.as(`/api/v1/barcodes/${code}`));

const HAIL_MARY = "9780593135204";
const LEAN_STARTUP = "9780307887894";
const DUNE = "9780441172719";

const edition = (title: string) => ({
  title, subtitle: null, pages: 496, release_date: "2021-05-04",
  image: { url: `https://assets.hardcover.app/${title}.jpg` }, language: { code2: "en" }, publisher: { name: "Ballantine" },
  contributions: [{ contribution: null, author: { name: "Andy Weir" } }, { contribution: "Narrator", author: { name: "Ray Porter" } }],
  book: { title, subtitle: null, description: "A lone astronaut…", contributions: [], book_series: [{ position: 1, series: { name: "Standalone" } }] },
});

/** Hardcover's endpoints, as far as Ferret uses them. */
class FakeHardcoverServer {
  calls: string[] = [];
  polls = 0;
  generation = 1;
  refusedAccess = new Set<string>();
  revoked = false;
  books: Record<string, string> = { [HAIL_MARY]: "Project Hail Mary", [LEAN_STARTUP]: "The Lean Startup", [DUNE]: "Dune" };
  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const form = init?.body instanceof URLSearchParams ? init.body : null;
    const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    this.calls.push(url.pathname + (form?.get("grant_type") ? ` ${form.get("grant_type")}` : ""));
    if (url.pathname === "/oauth2/device") {
      expect(form?.get("client_id")).toBe("c0166592-a689-4993-932c-f5089ffdc802");
      expect(form?.get("scope")).toBe("read:catalog:data read:catalog:search");
      return ok({ device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://hardcover.app/link", verification_uri_complete: "https://hardcover.app/link?code=ABCD-1234", expires_in: 900, interval: 5 });
    }
    if (url.pathname === "/oauth2/token" && form?.get("grant_type")?.endsWith("device_code")) {
      return ++this.polls < 2 ? ok({ error: "authorization_pending" }, 400) : ok({ access_token: "at-1", refresh_token: "rt-1", expires_in: 604800 });
    }
    if (url.pathname === "/oauth2/token" && form?.get("grant_type") === "refresh_token") {
      if (this.revoked || form.get("refresh_token") !== `rt-${this.generation}`) return ok({ error: "invalid_grant" }, 400);
      this.generation++;
      return ok({ access_token: `at-${this.generation}`, refresh_token: `rt-${this.generation}`, expires_in: 604800 });
    }
    if (url.pathname === "/oauth2/revoke") return ok({});
    if (url.pathname === "/v1/graphql") {
      const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
      if (this.refusedAccess.has(token) || token !== `at-${this.generation}`) return ok({ error: "invalid_token" }, 401);
      const { variables } = JSON.parse(String(init?.body)) as { variables: { isbn: string } };
      const title = this.books[variables.isbn];
      return ok({ data: { editions: title ? [edition(title)] : [] } });
    }
    return ok({}, 404);
  }) as typeof fetch;
}

class FakeOpenLibrary implements ProductLookup {
  async lookup(isbn: string): Promise<ProductInfo | null> {
    if (isbn !== LEAN_STARTUP) return null;
    return { barcode: isbn, title: "The Lean Startup", brand: "Eric Ries", category: "Books", images: [], source: "Open Library", kind: "book", book: { title: "The Lean Startup", authors: ["Eric Ries"], pages: 336 } };
  }
}

describe("Hardcover", () => {
  it("connects by a code, is asked with Open Library, renews its sign-in, and says when it's lost", async () => {
    const remote = new FakeHardcoverServer();
    let db: Db;
    const api: HardcoverApi = new HardcoverApi((opts) => hardcoverToken(db, config.FILES_KEY, api, opts), remote.fetch);
    const s = await setup({ books: new FakeOpenLibrary(), hardcover: api });
    db = s.db;
    const ann = await s.user("ann");
    await send(ann, "PUT", "/api/v1/server/books", { enabled: true });
    expect(await json(ann.as("/api/v1/server/books/hardcover"))).toMatchObject({ available: true, connected: false, pending: null, lostAt: null });
    expect((await scan(ann, HAIL_MARY)).match).toBeNull(); // not connected: not asked
    expect(remote.calls).toEqual([]);

    // The code to enter on hardcover.app; checked until it's approved.
    const started = await json<HardcoverStatus>(send(ann, "POST", "/api/v1/server/books/hardcover/start"));
    expect(started.pending).toMatchObject({ userCode: "ABCD-1234", verificationUri: "https://hardcover.app/link", interval: 5 });
    expect(await json(send(ann, "POST", "/api/v1/server/books/hardcover/check"))).toMatchObject({ connected: false, pending: { userCode: "ABCD-1234" } });
    const done = await json<HardcoverStatus>(send(ann, "POST", "/api/v1/server/books/hardcover/check"));
    expect(done).toMatchObject({ connected: true, pending: null });
    expect(JSON.stringify(done)).not.toContain("rt-1");

    // Asked now — a book Open Library didn't know (asked again: it was remembered as unknown).
    expect((await scan(ann, HAIL_MARY)).match).toMatchObject({ name: "Project Hail Mary", brand: "Andy Weir", sourceName: "Hardcover" });

    // Hardcover refuses the access token: renewed once (the new refresh token kept), and asked again.
    remote.refusedAccess.add("at-1");
    const lean = (await scan(ann, LEAN_STARTUP)).match;
    expect(lean).toMatchObject({ name: "The Lean Startup", sourceName: "Open Library and Hardcover" });
    expect(remote.calls.filter((c) => c.endsWith("refresh_token"))).toHaveLength(1);

    // Disconnected on hardcover.app: the connection is forgotten, and the server admin's bell says so.
    remote.revoked = true;
    remote.refusedAccess.add("at-2");
    expect((await scan(ann, DUNE)).match).toBeNull();
    const status = await json<HardcoverStatus>(ann.as("/api/v1/server/books/hardcover"));
    expect(status).toMatchObject({ connected: false, lostAt: expect.any(String) });
    const bell = await json<{ data: { id: string; title: string }[] }>(ann.as("/api/v1/attention"));
    expect(bell.data).toContainEqual(expect.objectContaining({ id: "service:hardcover", title: "Hardcover needs connecting again" }));

    // Other people can't connect or see it.
    const bob = await s.user("bob");
    expect((await send(bob, "POST", "/api/v1/server/books/hardcover/start")).status).toBe(403);
    expect(await json(send(ann, "DELETE", "/api/v1/server/books/hardcover"))).toMatchObject({ connected: false, lostAt: null });
  });

  it("reads an edition: its own authors (not narrators), series and cover", () => {
    expect(toBook(HAIL_MARY, edition("Project Hail Mary"))).toMatchObject({
      title: "Project Hail Mary", brand: "Andy Weir", images: ["https://assets.hardcover.app/Project Hail Mary.jpg"], source: "Hardcover",
      book: { authors: ["Andy Weir"], publisher: "Ballantine", pages: 496, synopsis: "A lone astronaut…", series: "Standalone #1", language: "en" },
    });
    expect(toBook(HAIL_MARY, { title: null, book: null })).toBeNull();
  });
});
