/**
 * Certificates for Ferret's own connections (Settings → Server → Certificates): authorities to trust for your own
 * services, and client certificates presented only to the hosts they name — tried against a real mutual-TLS server on
 * loopback, with certificates made by openssl for the test.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeTls, PUBLIC_AUTHORITIES, hostMatches } from "../src/adapters/local/certificates";
import { serverSetting } from "../src/db/schema";
import { applyCertificates } from "../src/lib/certificates";
import { config, setup } from "./helpers";

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(path.join(tmpdir(), "ferret-tls-"));
const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
const file = (name: string) => readFileSync(path.join(dir, name));

/** A test CA, a server certificate for localhost from it, and two client certificates (one expiring in 10 days). */
function makeCertificates() {
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  ssl("req", "-x509", ...ec, "-keyout", "ca.key", "-out", "ca.pem", "-days", "365", "-subj", "/CN=Ferret Test CA");
  writeFileSync(path.join(dir, "ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
  ssl("req", ...ec, "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost");
  ssl("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "90", "-extfile", "ext");
  for (const [name, days] of [["laptop", "90"], ["shortlived", "10"]] as const) {
    ssl("req", ...ec, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`);
    ssl("x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", days);
    ssl("pkcs12", "-export", "-inkey", `${name}.key`, "-in", `${name}.pem`, "-out", `${name}.p12`, "-passout", "pass:secret");
  }
}

describe.skipIf(!hasOpenssl)("certificates", () => {
  let server: https.Server;
  let port = 0;
  beforeAll(async () => {
    makeCertificates();
    // Asks every client for a certificate from the test CA, and answers with whose it got.
    server = https.createServer(
      { key: file("server.key"), cert: file("server.pem"), ca: file("ca.pem"), requestCert: true, rejectUnauthorized: false },
      (req, res) => res.end((req.socket as import("node:tls").TLSSocket).getPeerCertificate()?.subject?.CN ?? "no certificate"),
    );
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server?.close());

  const ask = async (host: string) => {
    try {
      return await (await fetch(`https://${host}:${port}/`)).text();
    } catch (err) {
      return `refused: ${(err as { cause?: { code?: string } }).cause?.code ?? String(err)}`;
    }
  };

  it("trusts an added authority, and presents a client certificate only to its hosts", async () => {
    const tls = new NodeTls();
    const { user, db } = await setup({ tls });
    const ann = await user("ann");
    const bob = await user("bob");
    const post = (who: typeof ann, url: string, body: object) => who.as(url, { method: "POST", body: JSON.stringify(body) });

    expect(await ask("localhost")).toMatch(/^refused: (SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/);
    // Only the server admin, and never a private key pasted by mistake.
    expect((await post(bob, "/api/v1/server/certificates/trusted", { pem: file("ca.pem").toString() })).status).toBe(403);
    const key = await post(ann, "/api/v1/server/certificates/trusted", { pem: file("ca.key").toString() });
    expect([key.status, ((await key.json()) as { error: { message: string } }).error.message]).toEqual([400, expect.stringMatching(/private key/)]);

    const added = await post(ann, "/api/v1/server/certificates/trusted", { name: "Home CA", pem: file("ca.pem").toString() });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ available: true, trusted: [{ name: "Home CA", subject: "CN=Ferret Test CA" }], clients: [] });
    expect((await post(ann, "/api/v1/server/certificates/trusted", { pem: file("ca.pem").toString() })).status).toBe(409);
    expect(await ask("localhost")).toBe("no certificate");

    // A client certificate: a wrong password says so; then it goes to localhost — and not to 127.0.0.1, the same server.
    const p12 = file("laptop.p12").toString("base64");
    const wrong = await post(ann, "/api/v1/server/certificates/client", { hosts: ["localhost"], pkcs12: p12, password: "nope" });
    expect([wrong.status, ((await wrong.json()) as { error: { message: string } }).error.message]).toEqual([400, "Wrong password for that file"]);
    expect((await post(ann, "/api/v1/server/certificates/client", { hosts: ["*"], pkcs12: p12, password: "secret" })).status).toBe(400);
    const client = await post(ann, "/api/v1/server/certificates/client", { name: "Ferret", hosts: ["LocalHost"], pkcs12: p12, password: "secret" });
    expect(client.status).toBe(201);
    const listed = (await client.json()) as { clients: Record<string, unknown>[] };
    expect(listed.clients).toEqual([expect.objectContaining({ name: "Ferret", subject: "CN=laptop", issuer: "CN=Ferret Test CA", hosts: ["localhost"] })]);
    // Its file and password never come back out, and aren't stored readable.
    expect(JSON.stringify(listed)).not.toContain(p12.slice(0, 40));
    const [row] = await db.select().from(serverSetting);
    expect(row!.value).not.toContain(p12.slice(0, 40));
    expect(row!.value).not.toContain("secret");
    expect(await ask("localhost")).toBe("laptop");
    expect(await ask("127.0.0.1")).toBe("no certificate");
    // One host, one certificate.
    expect((await post(ann, "/api/v1/server/certificates/client", { hosts: ["localhost"], pkcs12: file("shortlived.p12").toString("base64"), password: "secret" })).status).toBe(409);

    // A restart: what was kept is applied again.
    const again = new NodeTls();
    await applyCertificates({ db, tls: again }, config.FILES_KEY);
    expect(await ask("localhost")).toBe("laptop");

    // Removing them: back to how Node was.
    const id = listed.clients[0]!.id as string;
    expect((await ann.as(`/api/v1/server/certificates/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(await ask("localhost")).toBe("no certificate");
    const caId = ((await (await ann.as("/api/v1/server/certificates")).json()) as { trusted: { id: string }[] }).trusted[0]!.id;
    await ann.as(`/api/v1/server/certificates/${caId}`, { method: "DELETE" });
    expect(await ask("localhost")).toMatch(/^refused/);
  });

  it("warns the server admin before a certificate runs out", async () => {
    const tls = new NodeTls();
    const { user } = await setup({ tls });
    const ann = await user("ann");
    await ann.as("/api/v1/server/certificates/client", {
      method: "POST",
      body: JSON.stringify({ name: "Short", hosts: ["ha.example.lan"], pkcs12: file("shortlived.p12").toString("base64"), password: "secret" }),
    });
    const bell = (await (await ann.as("/api/v1/attention")).json()) as { data: { id: string; title: string; severity: string }[] };
    expect(bell.data).toContainEqual(expect.objectContaining({ title: "Certificate “Short” expires soon", severity: "soon" }));
    tls.apply([], []);
  });

  it("is off where the runtime can't do it", async () => {
    const { user } = await setup();
    const ann = await user("ann");
    expect(await (await ann.as("/api/v1/server/certificates")).json()).toEqual({ available: false, trusted: [], clients: [] });
    expect((await ann.as("/api/v1/server/certificates/trusted", { method: "POST", body: JSON.stringify({ pem: file("ca.pem").toString() }) })).status).toBe(404);
  });

  it("keeps the internet's authorities apart from those added", async () => {
    const tls = new NodeTls();
    tls.apply([file("ca.pem").toString()], []);
    expect(PUBLIC_AUTHORITIES).not.toContain(file("ca.pem").toString().trim());
    // download.ts passes this list as its `ca`, so what the admin added never vouches for a site on the internet.
    expect(PUBLIC_AUTHORITIES.length).toBeGreaterThan(50);
    tls.apply([], []);
  });
});

describe("which hosts get a client certificate", () => {
  it("matches the name itself, or anything under a wildcard", () => {
    expect(hostMatches(["ha.example.lan"], "HA.example.lan")).toBe(true);
    expect(hostMatches(["ha.example.lan"], "evil-ha.example.lan")).toBe(false);
    expect(hostMatches(["*.example.lan"], "spark1.example.lan")).toBe(true);
    expect(hostMatches(["*.example.lan"], "a.b.example.lan")).toBe(true);
    expect(hostMatches(["*.example.lan"], "example.lan")).toBe(false);
    expect(hostMatches(["*.example.lan"], "badexample.lan")).toBe(false);
    expect(hostMatches(["::1"], "[::1]")).toBe(true);
  });
});
