/**
 * Hardcover (hardcover.app): books by ISBN from its catalog, after the server admin connects a Hardcover account by
 * code (OAuth's device grant, as Ferret — a public app: no secret). Only catalog scopes are asked for, so it reads
 * books and editions and nothing of anyone's library. Plain fetch; only the ISBN is sent. Answers in the barcode books'
 * shape with the details field by field (`book`), for lib/books.ts to merge.
 */
import type { ProductInfo } from "@ferret/shared";
import type { Hardcover, HardcoverDevice, HardcoverTokens } from "../../ports";

/** Ferret's app on Hardcover (registered by the Ferret project; public by design — device-grant apps have no secret). */
export const HARDCOVER_CLIENT_ID = "c0166592-a689-4993-932c-f5089ffdc802";
const SCOPE = "read:catalog:data read:catalog:search";
const API = "https://api.hardcover.app";
const HEADERS = { Accept: "application/json", "User-Agent": "Ferret home inventory (book look-up)" };

/** Thrown when Hardcover refuses the token: lib/hardcover.ts refreshes it and asks once more. */
export class HardcoverUnauthorized extends Error {}

const EDITION = `query Edition($isbn: String!) {
  editions(where: {isbn_13: {_eq: $isbn}}, limit: 1) {
    title subtitle pages release_date
    image { url }
    language { code2 }
    publisher { name }
    contributions { contribution author { name } }
    book {
      title subtitle description
      contributions(where: {contributor_role: {slug: {_eq: "author"}}}) { author { name } }
      book_series(order_by: {position: asc_nulls_last}, limit: 1) { position series { name } }
    }
  }
}`;

type Edition = {
  title?: string | null;
  subtitle?: string | null;
  pages?: number | null;
  release_date?: string | null;
  image?: { url?: string | null } | null;
  language?: { code2?: string | null } | null;
  publisher?: { name?: string | null } | null;
  contributions?: { contribution?: string | null; author?: { name?: string | null } | null }[];
  book?: {
    title?: string | null;
    subtitle?: string | null;
    description?: string | null;
    contributions?: { author?: { name?: string | null } | null }[];
    book_series?: { position?: number | null; series?: { name?: string | null } | null }[];
  } | null;
};

const text = (v: string | null | undefined) => v?.trim() || undefined;

export function toBook(isbn: string, e: Edition): ProductInfo | null {
  const title = text(e.title) ?? text(e.book?.title);
  if (!title) return null;
  // The edition's own authors (not its translators or narrators), else the book's.
  const own = (e.contributions ?? []).filter((c) => !c.contribution || /author/i.test(c.contribution)).map((c) => text(c.author?.name));
  const authors = [...new Set((own.some(Boolean) ? own : (e.book?.contributions ?? []).map((c) => text(c.author?.name))).filter((a): a is string => Boolean(a)))];
  const series = e.book?.book_series?.[0];
  const seriesName = text(series?.series?.name);
  const cover = text(e.image?.url);
  return {
    barcode: isbn,
    title,
    ...(authors.length ? { brand: authors.slice(0, 3).join(", ") } : {}),
    category: "Books",
    images: cover?.startsWith("https://") ? [cover] : [],
    source: "Hardcover",
    kind: "book",
    book: {
      title,
      // No subtitle: Hardcover's are entered by readers and often aren't one ("Teacher's Book" on Dune); Open Library
      // and Google Books give it.
      ...(authors.length ? { authors } : {}),
      ...(text(e.publisher?.name) ? { publisher: text(e.publisher?.name) } : {}),
      ...(text(e.release_date) ? { published: text(e.release_date) } : {}),
      ...(e.pages ? { pages: e.pages } : {}),
      ...(text(e.book?.description) ? { synopsis: text(e.book?.description)!.slice(0, 2000) } : {}),
      ...(seriesName ? { series: series?.position ? `${seriesName} #${series.position}` : seriesName } : {}),
      ...(text(e.language?.code2) ? { language: text(e.language?.code2) } : {}),
      ...(cover?.startsWith("https://") ? { covers: [cover] } : {}),
    },
  };
}

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
const tokens = (r: TokenReply): HardcoverTokens => ({ accessToken: r.access_token!, refreshToken: r.refresh_token!, expiresIn: r.expires_in ?? 7 * 86_400 });

export class HardcoverApi implements Hardcover {
  constructor(
    /** The access token to look books up with (lib/hardcover.ts: refreshed when due), or null when not connected. */
    private readonly token: (opts?: { renew?: boolean }) => Promise<string | null>,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private form(path: string, fields: Record<string, string>) {
    return this.fetcher(`${API}${path}`, { method: "POST", headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields), signal: AbortSignal.timeout(20_000) });
  }

  async start(): Promise<HardcoverDevice> {
    const res = await this.form("/oauth2/device", { client_id: HARDCOVER_CLIENT_ID, scope: SCOPE });
    if (!res.ok) throw new Error(`Hardcover: HTTP ${res.status} starting the sign-in`);
    const d = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in?: number; interval?: number };
    return {
      deviceCode: d.device_code,
      userCode: d.user_code,
      verificationUri: d.verification_uri,
      ...(d.verification_uri_complete ? { verificationUriComplete: d.verification_uri_complete } : {}),
      expiresIn: d.expires_in ?? 900,
      interval: d.interval ?? 5,
    };
  }

  async poll(deviceCode: string) {
    const res = await this.form("/oauth2/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: HARDCOVER_CLIENT_ID });
    const body = (await res.json().catch(() => ({}))) as TokenReply;
    if (res.ok && body.access_token && body.refresh_token) return tokens(body);
    if (body.error === "authorization_pending") return "pending" as const;
    if (body.error === "slow_down") return "slow_down" as const;
    if (body.error === "access_denied") return "denied" as const;
    if (body.error === "expired_token" || body.error === "invalid_grant") return "expired" as const;
    throw new Error(`Hardcover: HTTP ${res.status} checking the sign-in${body.error ? ` (${body.error})` : ""}`);
  }

  async refresh(refreshToken: string) {
    const res = await this.form("/oauth2/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: HARDCOVER_CLIENT_ID });
    const body = (await res.json().catch(() => ({}))) as TokenReply;
    if (res.ok && body.access_token && body.refresh_token) return tokens(body);
    if (res.status === 400 || res.status === 401) return "revoked" as const;
    throw new Error(`Hardcover: HTTP ${res.status} renewing the sign-in`);
  }

  async revoke(refreshToken: string) {
    await this.form("/oauth2/revoke", { token: refreshToken, token_type_hint: "refresh_token", client_id: HARDCOVER_CLIENT_ID });
  }

  async lookup(isbn: string): Promise<ProductInfo | null> {
    let token = await this.token();
    if (!token) return null;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.edition(isbn, token);
      } catch (err) {
        // Refused: renew the token once and ask again.
        if (!(err instanceof HardcoverUnauthorized) || attempt > 0) throw err;
        token = await this.token({ renew: true });
        if (!token) return null;
      }
    }
  }

  private async edition(isbn: string, token: string) {
    const res = await this.fetcher(`${API}/v1/graphql`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: EDITION, variables: { isbn } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) throw new HardcoverUnauthorized("Hardcover: the sign-in was refused");
    if (!res.ok) throw new Error(`Hardcover: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { editions?: Edition[] }; errors?: { message?: string }[] };
    if (body.errors?.length) throw new Error(`Hardcover: ${body.errors[0]?.message ?? "the query failed"}`);
    const edition = body.data?.editions?.[0];
    return edition ? toBook(isbn, edition) : null;
  }
}
