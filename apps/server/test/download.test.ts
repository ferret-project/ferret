/** The downloader for "add from a web address": public internet only (no SSRF), redirects re-checked, size capped. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPublicAddress, SafeDownloader } from "../src/adapters/local/download";
import { sniffContentType } from "../src/lib/sniff";

describe("which addresses are public", () => {
  it("refuses private, loopback, link-local, CGNAT and other internal ranges — in every spelling", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.5",
      "192.168.1.50",
      "169.254.169.254", // cloud metadata
      "100.101.2.3", // Tailscale / CGNAT
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd7a:115c:a1e0::1",
      "::ffff:127.0.0.1",
      "::ffff:192.168.1.1",
      "64:ff9b::7f00:1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe("SafeDownloader", () => {
  const strict = new SafeDownloader();
  const MB = 1024 * 1024;
  // What the download job asks for: photos and PDFs, by declared type and by file signature.
  const wanted = ["image/jpeg", "image/png", "application/pdf"];
  const only = (maxBytes = MB) => ({
    maxBytes,
    contentTypes: wanted,
    accepts: (head: Uint8Array) => wanted.includes(sniffContentType(head) ?? ""),
  });

  it("won't fetch internal addresses, other schemes or ports, or URLs with credentials", async () => {
    for (const [url, reason] of [
      ["http://127.0.0.1/x.jpg", /private network/],
      ["http://[::1]/x.jpg", /private network/],
      ["http://169.254.169.254/latest/meta-data/", /private network/],
      ["http://[::ffff:192.168.1.1]/", /private network/],
      ["http://localhost/x.jpg", /private network/], // resolves to loopback
      ["ftp://example.com/x.pdf", /Only http and https/],
      ["file:///etc/passwd", /Only http and https/],
      ["http://example.com:8123/x.jpg", /standard web ports/],
      ["https://user:pw@example.com/x.pdf", /username or password/],
      ["not a url", /isn't a web address/],
    ] as const) {
      await expect(strict.get(url, only()), url).rejects.toThrow(reason);
    }
  });

  // A local server stands in for "the internet": 127.0.0.1 is let through, 127.0.0.2 isn't.
  let server: Server;
  let port: number;
  const loose = () => new SafeDownloader({ allowAddress: (ip) => ip === "127.0.0.1", ports: [port] });
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/manual.pdf") return res.writeHead(200, { "Content-Type": "application/pdf" }).end("%PDF-1.7 hello");
      if (req.url === "/download?id=7")
        return res.writeHead(200, { "Content-Disposition": 'attachment; filename="DCD771 Manual.pdf"' }).end("%PDF-1.7 hi");
      if (req.url === "/moved") return res.writeHead(302, { Location: "/manual.pdf" }).end();
      if (req.url === "/sneaky") return res.writeHead(302, { Location: `http://127.0.0.2:${port}/manual.pdf` }).end();
      if (req.url === "/loop") return res.writeHead(302, { Location: "/loop" }).end();
      if (req.url === "/big") return res.writeHead(200).end(Buffer.alloc(2 * MB));
      if (req.url === "/cookie") return res.writeHead(200, { "Content-Type": "application/pdf" }).end(`%PDF-1.7 ${req.headers.cookie ?? "none"}`);
      if (req.url === "/page") {
        // A web page: refused on its Content-Type, before the body is read.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.write("<html><script>alert(1)</script>");
        return void setTimeout(() => res.end("</html>"), 5_000);
      }
      if (req.url === "/liar") return res.writeHead(200, { "Content-Type": "application/pdf" }).end(`<html>${"x".repeat(5000)}</html>`);
      if (req.url === "/logo.svg") return res.writeHead(200, { "Content-Type": "image/svg+xml" }).end("<svg onload='alert(1)'/>");
      if (req.url === "/app.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end("alert(1)");
      if (req.url === "/untyped") return res.writeHead(200, { "Content-Type": "application/octet-stream" }).end("%PDF-1.4 a pdf");
      if (req.url === "/short") return res.writeHead(200).end("hi");
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("downloads, follows redirects, and names the file", async () => {
    const got = await loose().get(`http://127.0.0.1:${port}/moved`, only());
    expect(new TextDecoder().decode(got.bytes)).toBe("%PDF-1.7 hello");
    expect(got).toMatchObject({ filename: "manual.pdf", finalUrl: `http://127.0.0.1:${port}/manual.pdf` });
    expect((await loose().get(`http://127.0.0.1:${port}/download?id=7`, only())).filename).toBe("DCD771 Manual.pdf");
    expect(new TextDecoder().decode((await loose().get(`http://127.0.0.1:${port}/cookie`, only())).bytes)).toBe("%PDF-1.7 none");
    expect(new TextDecoder().decode((await loose().get(`http://127.0.0.1:${port}/untyped`, only())).bytes)).toBe("%PDF-1.4 a pdf");
  });

  it("checks every redirect, and stops at the size cap, a redirect loop, or a 404", async () => {
    await expect(loose().get(`http://127.0.0.1:${port}/sneaky`, only())).rejects.toThrow(/private network/);
    await expect(loose().get(`http://127.0.0.1:${port}/big`, { ...only(), contentTypes: ["application/octet-stream"], accepts: () => true })).rejects.toThrow(/bigger than 1 MB/);
    await expect(loose().get(`http://127.0.0.1:${port}/loop`, only())).rejects.toThrow(/Too many redirects/);
    await expect(loose().get(`http://127.0.0.1:${port}/nothing`, only())).rejects.toThrow(/answered 404/);
  });

  it("never downloads web pages, scripts or SVG — by declared type, or by the first bytes when the type lies", async () => {
    const started = Date.now();
    await expect(loose().get(`http://127.0.0.1:${port}/page`, only())).rejects.toThrow(/web page, not the file itself/);
    expect(Date.now() - started).toBeLessThan(2_000); // refused on the headers, not after the slow body
    await expect(loose().get(`http://127.0.0.1:${port}/liar`, only())).rejects.toThrow(/isn't a photo or a PDF/);
    await expect(loose().get(`http://127.0.0.1:${port}/logo.svg`, only())).rejects.toThrow(/image\/svg\+xml, not a photo or PDF/);
    await expect(loose().get(`http://127.0.0.1:${port}/app.js`, only())).rejects.toThrow(/text\/javascript, not a photo or PDF/);
    await expect(loose().get(`http://127.0.0.1:${port}/short`, only())).rejects.toThrow(/isn't a photo or a PDF/);
  });
});
