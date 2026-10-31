/** The API description: every route documented, and the document well-formed. */
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/lib/openapi";
import { setup } from "./helpers";

describe("OpenAPI", () => {
  it("documents every /api/v1 route, and nothing that isn't one", async () => {
    const { app } = await setup();
    const actual = new Set(
      app.routes
        .filter((r) => r.method !== "ALL" && r.path.startsWith("/api/v1/"))
        // Hono's ":code{[0-9A-Z]…}" → OpenAPI's "{code}".
        .map((r) => `${r.method.toLowerCase()} ${r.path.slice("/api/v1".length).replace(/:(\w+)(\{[^}]*\}+)?/g, "{$1}")}`),
    );
    const documented = new Set(OPERATIONS.map((o) => `${o.method} ${o.path}`));
    expect([...actual].filter((r) => !documented.has(r))).toEqual([]); // add an OPERATIONS entry in lib/openapi.ts
    expect([...documented].filter((r) => !actual.has(r))).toEqual([]);
  });

  it("turns away every route that needs a sign-in when there isn't one", async () => {
    // Auth is attached per path in routes/inventory.ts (inventory.use(…)): a new path prefix must be added there.
    const { app } = await setup();
    const open: string[] = [];
    for (const op of OPERATIONS.filter((o) => o.auth !== "none")) {
      const url = `/api/v1${op.path.replace(/\{[^}]+\}/g, "x")}`;
      const res = await app.request(url, {
        method: op.method.toUpperCase(),
        headers: { "Content-Type": "application/json", Origin: "http://localhost:8787" },
        body: op.method === "get" ? undefined : "{}",
      });
      if (res.status !== 401) open.push(`${op.method} ${op.path} → ${res.status}`);
    }
    expect(open).toEqual([]);
  });

  it("serves an OpenAPI 3.1 document to signed-in callers only", async () => {
    const { app, user } = await setup();
    expect((await app.request("/api/v1/openapi.json")).status).toBe(401);
    const ann = await user("ann");
    const res = await ann.as("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: { required?: string[]; properties: Record<string, unknown> } }> }; responses: Record<string, unknown>; security: unknown[] }>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    const create = doc.paths["/items"]!.post!;
    expect(create.requestBody!.content["application/json"]!.schema.required).toContain("name");
    expect(Object.keys(create.requestBody!.content["application/json"]!.schema.properties)).toEqual(expect.arrayContaining(["tags", "categoryId", "isContainer"]));
    expect(Object.keys(create.responses)).toContain("201");
    expect(Object.keys(doc.paths["/items/{id}"]!.delete!.responses)).toContain("204");
    expect(doc.paths["/auth-options"]!.get!.security).toEqual([]);
    expect(doc.paths["/items/{id}/attachments"]!.post!.requestBody!.content).toHaveProperty("multipart/form-data");
  });
});
