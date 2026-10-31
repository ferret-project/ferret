/**
 * #/api — the REST API, read from /api/v1/openapi.json (lib/openapi.ts on the server). Laid out like an API docs
 * site: an introduction (quick start, keys, errors, paging), then every endpoint grouped by area — what it does and
 * its fields on the left, a request in curl / JavaScript / Python (copyable, bodies made from the schemas) and what
 * comes back on the right, side by side from `lg`. A sticky list of areas follows the page; on phones, a "Jump to".
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { settingsHref } from "./lib/route";

interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
  anyOf?: Schema[];
  format?: string;
  default?: unknown;
  description?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}
interface Param {
  name: string;
  in: "path" | "query";
  schema: Schema;
  description?: string;
}
interface Op {
  tags: string[];
  summary: string;
  description?: string;
  operationId: string;
  security: Record<string, unknown>[];
  parameters: Param[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { description: string; content?: Record<string, unknown> }>;
}
interface Doc {
  info: { description: string };
  servers: { url: string }[];
  tags: { name: string }[];
  paths: Record<string, Record<string, Op>>;
}
interface Endpoint {
  path: string;
  method: string;
  op: Op;
}

const METHOD_BADGE: Record<string, string> = {
  get: "badge-success",
  post: "badge-primary",
  put: "badge-warning",
  patch: "badge-warning",
  delete: "badge-error",
};

/** "string", "integer ≤ 1000", "one of: a, b", "list of string"… */
function describe(s: Schema | undefined): string {
  if (!s) return "";
  if (s.enum) return `one of: ${s.enum.join(", ")}`;
  if (s.anyOf) return [...new Set(s.anyOf.map(describe).filter((t) => t && t !== "null"))].join(" or ") + (s.anyOf.some((a) => a.type === "null") ? " (or null)" : "");
  const type = Array.isArray(s.type) ? s.type.filter((t) => t !== "null").join(" | ") + (s.type.includes("null") ? " (or null)" : "") : (s.type ?? "any");
  if (type === "array") return `list of ${describe(s.items)}`;
  const limits = [s.format, s.maxLength !== undefined && `≤ ${s.maxLength} chars`, s.minimum !== undefined && `≥ ${s.minimum}`, s.maximum !== undefined && s.maximum < Number.MAX_SAFE_INTEGER && `≤ ${s.maximum}`]
    .filter(Boolean)
    .join(", ");
  return limits ? `${type} (${limits})` : type;
}

// ── Examples made from the schemas ──────────────────────────────────────────

/** Believable values for the fields people send most; anything else gets one by its type. */
const SAMPLE: Record<string, unknown> = {
  name: "Cordless drill",
  q: "drill",
  question: "Where is the drill?",
  brand: "DEWALT",
  model: "DCD791D2",
  serialNumber: "3141592",
  barcode: "0885911475167",
  email: "sam@example.com",
  person: "Sam (next door)",
  title: "Replace the furnace filter",
  provider: "DEWALT",
  tag: "insured",
  description: "With two batteries and the charger",
  notes: "Lives on the pegboard",
  url: "https://example.com/manual.pdf",
  code: "K7Q2MX",
};

function sample(name: string, s: Schema | undefined, depth = 0): unknown {
  if (!s) return null;
  if (name in SAMPLE && (s.type === "string" || !s.type || s.anyOf)) return SAMPLE[name];
  if (s.default !== undefined) return s.default;
  if (s.enum) return s.enum[0];
  if (s.anyOf) return sample(name, s.anyOf.find((a) => a.type !== "null"), depth);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  switch (type) {
    case "object":
      return depth > 2 ? {} : body(s, depth + 1);
    case "array":
      return [sample(name.replace(/s$/, ""), s.items, depth + 1)];
    case "boolean":
      return true;
    case "integer":
    case "number":
      return /Cents$/.test(name) ? 9_900 : /[Qq]uantity|count|step/.test(name) ? 1 : (s.minimum ?? 1);
    default:
      if (s.format === "date" || /On$|Date$/.test(name)) return "2026-10-24";
      if (s.format === "email") return "sam@example.com";
      if (s.format === "uri" || /url$/i.test(name)) return "https://example.com";
      if (/Id$/.test(name)) return "…";
      return "…";
  }
}

/** A JSON body: the required fields, then optional ones up to four in all. */
function body(s: Schema, depth = 0) {
  const props = Object.entries(s.properties ?? {});
  const required = props.filter(([n]) => s.required?.includes(n));
  const optional = props.filter(([n]) => !s.required?.includes(n) && !/Id$/.test(n));
  const chosen = [...required, ...optional.slice(0, Math.max(0, 4 - required.length))];
  return Object.fromEntries(chosen.map(([n, p]) => [n, sample(n, p, depth)]));
}

type Lang = "curl" | "js" | "python";
const LANGS: { id: Lang; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "js", label: "JavaScript" },
  { id: "python", label: "Python" },
];

/** The same request three ways. Path parameters show as <id>. */
function examples(base: string, { path, method, op }: Endpoint): Record<Lang, string> {
  const json = op.requestBody?.content["application/json"]?.schema;
  const upload = op.requestBody?.content["multipart/form-data"];
  const open = op.security.length === 0;
  const hasQ = op.parameters.some((p) => p.in === "query" && p.name === "q");
  const url = `${base}${path.replace(/\{(\w+)\}/g, "<$1>")}${hasQ && method === "get" ? "?q=drill" : ""}`;
  const M = method.toUpperCase();
  const payload = json ? JSON.stringify(body(json), null, 2) : null;

  const curl = [
    `curl${method === "get" ? "" : ` -X ${M}`} "${url}"`,
    !open && `  -H "Authorization: Bearer $FERRET_KEY"`,
    payload && `  -H "Content-Type: application/json"`,
    payload && `  -d '${payload.replace(/\n/g, "\n  ")}'`,
    upload && `  -F file=@photo.jpg -F kind=photo`,
  ]
    .filter(Boolean)
    .join(" \\\n");

  const headers = [!open && "Authorization: `Bearer ${process.env.FERRET_KEY}`", payload && `"Content-Type": "application/json"`].filter(Boolean);
  const js = [
    upload && `const form = new FormData();\nform.append("file", photoBlob, "photo.jpg");\nform.append("kind", "photo");\n`,
    `const res = await fetch("${url}", {`,
    method !== "get" && `  method: "${M}",`,
    headers.length && `  headers: { ${headers.join(", ")} },`,
    payload && `  body: JSON.stringify(${payload.replace(/^(\s*)"(\w+)":/gm, "$1$2:").replace(/\n/g, "\n  ")}),`,
    upload && `  body: form,`,
    `});`,
    `if (!res.ok) throw new Error((await res.json()).error.message);`,
    op.responses["204"] ? null : `const data = await res.json();`,
  ]
    .filter(Boolean)
    .join("\n");

  const py = (v: unknown) => JSON.stringify(v, null, 4).replace(/\btrue\b/g, "True").replace(/\bfalse\b/g, "False").replace(/\bnull\b/g, "None");
  const args = [
    `"${url}"`,
    !open && `headers={"Authorization": f"Bearer {os.environ['FERRET_KEY']}"}`,
    json && `json=${py(body(json)).replace(/\n/g, "\n    ")}`,
    upload && `files={"file": open("photo.jpg", "rb")}, data={"kind": "photo"}`,
  ].filter(Boolean);
  const python = [`import os, requests`, ``, `r = requests.${method}(\n    ${args.join(",\n    ")},\n)`, `r.raise_for_status()`, op.responses["204"] ? null : `print(r.json())`]
    .filter((l) => l !== null)
    .join("\n");

  return { curl, js, python };
}

// ── The page ────────────────────────────────────────────────────────────────

const INTRO = [
  { id: "api-start", label: "Quick start" },
  { id: "api-keys", label: "Keys" },
  { id: "api-errors", label: "Errors" },
  { id: "api-paging", label: "Pages of results" },
];
const tagId = (tag: string) => `api-${tag.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const LANG_KEY = "ferret.api.lang";

function readLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    return LANGS.some((l) => l.id === saved) ? (saved as Lang) : "curl";
  } catch {
    return "curl";
  }
}

/** Scrolls to a section by id (plain #anchors would be read by the router). */
const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

export function ApiReference() {
  const doc = useQuery({ queryKey: ["openapi"], queryFn: async () => (await (await fetch("/api/v1/openapi.json")).json()) as Doc, staleTime: Infinity });
  const base = doc.data?.servers[0]?.url ?? `${window.location.origin}/api/v1`;
  const [find, setFind] = useState("");
  const [lang, setLangState] = useState<Lang>(readLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      // remembered for this visit only
    }
  };

  const areas = useMemo(() => {
    const all: Endpoint[] = Object.entries(doc.data?.paths ?? {}).flatMap(([path, ops]) => Object.entries(ops).map(([method, op]) => ({ path, method, op })));
    const words = find.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = all.filter(({ path, method, op }) => words.every((w) => `${method} ${path} ${op.summary} ${op.tags[0]}`.toLowerCase().includes(w)));
    return (doc.data?.tags ?? []).map(({ name }) => ({ name, id: tagId(name), endpoints: shown.filter((e) => e.op.tags[0] === name) })).filter((a) => a.endpoints.length);
  }, [doc.data, find]);
  const count = areas.reduce((n, a) => n + a.endpoints.length, 0);
  const active = useActiveSection([...INTRO.map((s) => s.id), ...areas.map((a) => a.id)]);

  return (
    <div className="min-h-dvh bg-base-100">
      <nav className="navbar sticky top-0 z-20 border-b border-base-300 bg-base-100/85 backdrop-blur-md px-4">
        <div className="navbar-start items-center gap-2">
          <a href={settingsHref("api")} className="btn btn-text btn-sm btn-square" aria-label="Back to settings">
            <span className="icon-[tabler--arrow-left] size-5" />
          </a>
          <h1 className="text-lg font-semibold">API reference</h1>
        </div>
        <div className="navbar-end items-center">
          <a href="/api/v1/openapi.json" download="ferret-openapi.json" className="btn btn-soft btn-primary btn-sm">
            <span className="icon-[tabler--download] size-4" />
            OpenAPI
          </a>
        </div>
      </nav>

      <div className="mx-auto flex max-w-7xl gap-10 px-4 lg:px-8">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-56 shrink-0 flex-col gap-4 overflow-y-auto py-6 lg:flex" aria-label="API sections">
          <FindBox value={find} onChange={setFind} />
          <SectionList title="Introduction" items={INTRO} active={active} />
          <SectionList title={`Endpoints (${count})`} items={areas.map((a) => ({ id: a.id, label: a.name, count: a.endpoints.length }))} active={active} />
        </aside>

        <main className="min-w-0 flex-1 pb-[max(2rem,env(safe-area-inset-bottom))]">
          <Intro base={base} lang={lang} setLang={setLang} />

          {/* Phones: find and jump, in place of the side list. */}
          <div className="sticky top-16 z-10 -mx-4 flex flex-wrap gap-2 border-b border-base-300 bg-base-100/95 px-4 py-2 backdrop-blur-md lg:hidden">
            <div className="min-w-40 flex-1">
              <FindBox value={find} onChange={setFind} />
            </div>
            <select className="select w-auto max-w-48" aria-label="Jump to an area" value="" onChange={(e) => jump(e.target.value)}>
              <option value="" disabled>
                Jump to…
              </option>
              {areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.endpoints.length})
                </option>
              ))}
            </select>
          </div>

          {doc.isPending && <span className="loading loading-spinner text-primary mx-auto my-12 block" />}
          {doc.isError && <div className="alert alert-soft alert-error my-6">Couldn't load the API description.</div>}
          {doc.data && areas.length === 0 && <p className="py-12 text-center text-base-content/70">No endpoint matches "{find}".</p>}

          {areas.map((a) => (
            <section key={a.id} id={a.id} className="scroll-mt-28 pt-10 lg:scroll-mt-20" aria-labelledby={`${a.id}-h`}>
              <h2 id={`${a.id}-h`} className="flex items-baseline gap-2 text-2xl font-semibold text-base-content">
                {a.name}
                <span className="text-sm font-normal text-base-content/70">{a.endpoints.length}</span>
              </h2>
              {a.endpoints.map((e) => (
                <EndpointRow key={`${e.method} ${e.path}`} base={base} endpoint={e} lang={lang} setLang={setLang} />
              ))}
            </section>
          ))}
        </main>
      </div>
    </div>
  );
}

/** The section nearest the top of the screen, for the side list. */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join(" ");
  useEffect(() => {
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = key.split(" ").find((id) => seen.get(id));
        if (first) setActive(first);
      },
      { rootMargin: "-80px 0px -60% 0px" },
    );
    for (const id of key.split(" ")) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key]);
  return active;
}

function FindBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="input flex shrink-0 items-center gap-2">
      <span className="icon-[tabler--search] size-4 shrink-0 text-base-content/70" />
      <span className="sr-only">Find an endpoint</span>
      <input type="search" className="grow" placeholder="Find…" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function SectionList({ title, items, active }: { title: string; items: { id: string; label: string; count?: number }[]; active: string | null }) {
  return (
    <div>
      <h2 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-base-content/70">{title}</h2>
      <ul className="flex shrink-0 flex-col border-l border-base-content/10">
        {items.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => jump(s.id)}
              aria-current={active === s.id ? "location" : undefined}
              className={`-ml-px flex w-full items-center justify-between gap-2 border-l py-1 pr-2 pl-3 text-left text-sm transition-colors ${
                active === s.id ? "border-primary font-medium text-primary" : "border-transparent text-base-content/80 hover:border-base-content/30 hover:text-base-content"
              }`}
            >
              {s.label}
              {s.count !== undefined && <span className="text-xs text-base-content/70">{s.count}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Introduction ────────────────────────────────────────────────────────────

function Intro({ base, lang, setLang }: { base: string; lang: Lang; setLang: (l: Lang) => void }) {
  const start = examples(base, {
    path: "/items",
    method: "get",
    op: { tags: [], summary: "", operationId: "", security: [{ apiKey: [] }], parameters: [{ name: "q", in: "query", schema: {} }], responses: { "200": { description: "" } } },
  });
  return (
    <div className="flex flex-col">
      <header className="relative -mx-4 overflow-hidden px-4 pt-10 pb-8 lg:mx-0 lg:px-0">
        <GridPattern />
        <p className="relative text-sm font-semibold text-primary">REST · JSON · OpenAPI 3.1</p>
        <h2 className="relative mt-2 text-3xl font-bold tracking-tight text-base-content sm:text-4xl">Ferret API</h2>
        <p className="relative mt-3 max-w-2xl text-lg text-base-content/80">
          Everything the app does, for your own scripts and tools: add things, search them, log maintenance, read the insurance report. Claude uses the same
          household through MCP.
        </p>
      </header>

      <Row id="api-start" title="Quick start">
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-base-content/80">
          <li>
            Make a key in{" "}
            <a href={settingsHref("api")} className="link link-primary">
              Settings → Claude &amp; API
            </a>
            . It starts with <code className="font-mono text-sm">ferret_</code> and is shown once.
          </li>
          <li>
            Send it with every request as <code className="font-mono text-sm">Authorization: Bearer ferret_…</code>.
          </li>
          <li>
            Every call acts in the key's household. Base URL: <code className="break-all font-mono text-sm">{base}</code>
          </li>
        </ol>
        <CodeGroup title="Find the drill" code={start} lang={lang} setLang={setLang} />
      </Row>

      <Row id="api-keys" title="Keys">
        <div className="flex flex-col gap-3 text-base-content/80">
          <p>A key belongs to you and to one household. If you leave the household, the key stops working.</p>
          <p>
            <strong className="font-semibold text-base-content">Read-only keys</strong> can call everything except the endpoints marked <Badge kind="writes" />. Some
            endpoints are <Badge kind="session" />: they need the app's own sign-in, never a key.
          </p>
          <p>
            The key can go in <code className="font-mono text-sm">x-api-key</code> instead, if your tool can't set a bearer token.
          </p>
        </div>
        <Panel title="Two ways to send it" code={`Authorization: Bearer ferret_…\n\nx-api-key: ferret_…`} />
      </Row>

      <Row id="api-errors" title="Errors">
        <div className="flex flex-col gap-3 text-base-content/80">
          <p>
            Anything that isn't a success comes back with a status and the same shape. <code className="font-mono text-sm">message</code> is written for people:
            show it.
          </p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
            {[
              ["401", "No key, or one that's been revoked"],
              ["402", "The household's plan doesn't include it"],
              ["403", "A read-only key or a viewer trying to change something"],
              ["404", "Not found in this household"],
              ["409", "It conflicts with something already there"],
              ["413", "Too big: JSON bodies are 1 MB at most"],
              ["422", "Invalid input — details says which field"],
              ["429", "Too many requests: slow down"],
            ].map(([code, what]) => (
              <div key={code} className="contents">
                <dt className="font-mono text-base-content">{code}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </div>
        <Panel title="422 Invalid input" code={JSON.stringify({ error: { code: "http_422", message: "Invalid input", details: [{ path: ["name"], message: "Too small: expected string to have >=1 characters" }] } }, null, 2)} />
      </Row>

      <Row id="api-paging" title="Pages of results">
        <div className="flex flex-col gap-3 text-base-content/80">
          <p>
            Lists come a page at a time: <code className="font-mono text-sm">limit</code> (up to 200, 50 if not given) and{" "}
            <code className="font-mono text-sm">offset</code>. When there's more, <code className="font-mono text-sm">more</code> is true — ask again with a
            bigger offset.
          </p>
          <p>Money is in cents (9900 is $99.00). Dates are yyyy-mm-dd; moments are ISO 8601 in UTC.</p>
        </div>
        <Panel title="The next page" code={`curl "${base}/items?limit=50&offset=50" \\\n  -H "Authorization: Bearer $FERRET_KEY"`} />
      </Row>
    </div>
  );
}

/** Words on the left, code on the right (stacked on phones). */
function Row({ id, title, children }: { id: string; title: string; children: [React.ReactNode, React.ReactNode] }) {
  return (
    <section id={id} className="scroll-mt-28 border-t border-base-content/10 py-8 lg:scroll-mt-20" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="mb-4 text-xl font-semibold text-base-content">
        {title}
      </h2>
      <div className="grid gap-6 lg:grid-cols-2 lg:gap-10">
        <div className="min-w-0">{children[0]}</div>
        <div className="min-w-0">{children[1]}</div>
      </div>
    </section>
  );
}

/** The faint grid behind the heading (decoration, so hidden from screen readers). */
function GridPattern() {
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full text-primary/10 [mask-image:linear-gradient(to_bottom,white,transparent)]">
      <defs>
        <pattern id="api-grid" width="48" height="48" patternUnits="userSpaceOnUse" x="-1" y="-1">
          <path d="M48 0H0V48" fill="none" stroke="currentColor" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#api-grid)" />
    </svg>
  );
}

// ── An endpoint ─────────────────────────────────────────────────────────────

function EndpointRow({ base, endpoint, lang, setLang }: { base: string; endpoint: Endpoint; lang: Lang; setLang: (l: Lang) => void }) {
  const { path, method, op } = endpoint;
  const json = op.requestBody?.content["application/json"]?.schema;
  const upload = op.requestBody?.content["multipart/form-data"]?.schema;
  const session = op.security.length === 1 && "session" in op.security[0]!;
  const open = op.security.length === 0;
  // The server appends these to the description; here they're a badge and the response panel.
  const writes = op.description?.includes("Not for read-only keys or viewers.") ?? false;
  const returns = op.description?.match(/Returns: ([\s\S]+?)\.?$/)?.[1];
  const words = op.description?.replace("Not for read-only keys or viewers.", "").replace(/Returns: [\s\S]+$/, "").trim();
  const pathParams = op.parameters.filter((p) => p.in === "path");
  const query = op.parameters.filter((p) => p.in === "query");
  const code = useMemo(() => examples(base, endpoint), [base, endpoint]);

  return (
    <article id={op.operationId} className="scroll-mt-28 border-t border-base-content/10 py-8 first-of-type:border-t-0 lg:scroll-mt-20">
      <div className="grid gap-6 lg:grid-cols-2 lg:gap-10">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`badge badge-soft badge-sm font-mono uppercase ${METHOD_BADGE[method]}`}>{method}</span>
              <PathLabel path={path} />
            </div>
            <h3 className="text-lg font-semibold text-base-content">{op.summary}</h3>
            {(writes || session || open) && (
              <div className="flex flex-wrap gap-1.5">
                {writes && <Badge kind="writes" />}
                {session && <Badge kind="session" />}
                {open && <Badge kind="open" />}
              </div>
            )}
          </div>
          {words && <Prose text={words} />}
          {pathParams.length > 0 && <Properties title="Path" rows={pathParams.map((p) => ({ name: p.name, type: "string", required: true, about: p.description }))} />}
          {query.length > 0 && <Properties title="Query" rows={query.map((p) => ({ name: p.name, type: describe(p.schema), required: false, about: p.description ?? p.schema.description }))} />}
          {json?.properties && (
            <Properties
              title="Body (JSON)"
              rows={Object.entries(json.properties).map(([name, s]) => ({ name, type: describe(s), required: json.required?.includes(name) ?? false, about: s.description }))}
            />
          )}
          {upload?.properties && (
            <Properties
              title="Body (multipart form)"
              rows={Object.entries(upload.properties).map(([name, s]) => ({ name, type: s.format === "binary" ? "the file" : describe(s), required: upload.required?.includes(name) ?? false }))}
            />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          <CodeGroup title={`${method.toUpperCase()} ${path}`} code={code} lang={lang} setLang={setLang} />
          <Responses op={op} returns={returns} />
        </div>
      </div>
    </article>
  );
}

function PathLabel({ path }: { path: string }) {
  return (
    <code className="break-all font-mono text-sm text-base-content/80">
      {path.split(/(\{\w+\})/).map((part, i) => (part.startsWith("{") ? <span key={i} className="text-primary">{part}</span> : part))}
    </code>
  );
}

const BADGES = {
  writes: { label: "changes things", className: "badge-warning" },
  session: { label: "sign-in only", className: "badge-secondary" },
  open: { label: "no key", className: "badge-info" },
};
function Badge({ kind }: { kind: keyof typeof BADGES }) {
  return <span className={`badge badge-soft badge-sm ${BADGES[kind].className}`}>{BADGES[kind].label}</span>;
}

/** The server's descriptions: paragraphs, with `code` in backticks. */
function Prose({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 text-base-content/80">
      {text.split(/\n\n+/).map((para, i) => (
        <p key={i}>
          {para.split(/`([^`]+)`/).map((bit, j) => (j % 2 ? <code key={j} className="rounded bg-base-200 px-1 py-0.5 font-mono text-sm text-base-content">{bit}</code> : bit))}
        </p>
      ))}
    </div>
  );
}

function Properties({ title, rows }: { title: string; rows: { name: string; type: string; required: boolean; about?: string }[] }) {
  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold text-base-content">{title}</h4>
      <ul className="divide-y divide-base-content/10 border-t border-base-content/10">
        {rows.map((r) => (
          <li key={r.name} className="flex flex-col gap-1 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <code className="font-mono text-sm font-medium text-base-content">{r.name}</code>
              <span className="font-mono text-xs break-words text-base-content/70">{r.type}</span>
              {r.required && <span className="text-xs font-medium text-error">required</span>}
            </div>
            {r.about && <p className="text-sm text-base-content/70">{r.about}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Responses({ op, returns }: { op: Op; returns?: string }) {
  const rows = Object.entries(op.responses).map(([status, r]) => {
    const type = Object.keys(r.content ?? {})[0];
    const what = status.startsWith("2") && returns && returns !== status ? returns : r.description;
    return { status, what, type: type && type !== "application/json" ? type : null };
  });
  return (
    <div className="code-panel overflow-hidden rounded-box">
      <div className="code-panel-bar flex items-center px-4 py-2.5 text-xs font-semibold">Response</div>
      <ul className="flex flex-col gap-2 p-4 text-sm">
        {rows.map((r) => (
          <li key={r.status} className="flex gap-3">
            <span className={`font-mono font-semibold ${r.status.startsWith("2") ? "code-panel-ok" : "code-panel-dim"}`}>{r.status}</span>
            <span className="min-w-0 break-words">
              {r.what}
              {r.type && <span className="code-panel-dim"> · {r.type}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Code panels ─────────────────────────────────────────────────────────────

function CodeGroup({ title, code, lang, setLang }: { title: string; code: Record<Lang, string>; lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div className="code-panel overflow-hidden rounded-box">
      <div className="code-panel-bar flex flex-wrap items-center gap-x-4 px-4">
        <h4 className="mr-auto min-w-0 truncate py-2.5 font-mono text-xs font-semibold">{title}</h4>
        <div role="tablist" aria-label="Language" className="-mb-px flex gap-3 text-xs font-medium">
          {LANGS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={lang === l.id}
              onClick={() => setLang(l.id)}
              className={`tap border-b-2 py-2.5 transition-colors ${lang === l.id ? "code-panel-tab-on" : "code-panel-dim border-transparent"}`}
            >
              {l.label}
            </button>
          ))}
        </div>
        <CopyButton text={code[lang]} />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed" role="tabpanel">
        <code>{code[lang]}</code>
      </pre>
    </div>
  );
}

function Panel({ title, code }: { title: string; code: string }) {
  return (
    <div className="code-panel overflow-hidden rounded-box">
      <div className="code-panel-bar flex items-center gap-4 px-4">
        <h4 className="mr-auto py-2.5 font-mono text-xs font-semibold">{title}</h4>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button type="button" onClick={copy} className="code-panel-copy tap -mr-1 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-field transition-colors" aria-label={copied ? "Copied" : "Copy"}>
      <span className={`${copied ? "icon-[tabler--copy-check]" : "icon-[tabler--copy]"} size-4`} />
    </button>
  );
}
