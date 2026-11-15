/** The Node webhook sender: the server's own network only when allowed, no redirects followed, a status back. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeWebhookSender } from "../src/adapters/local/webhooks";

let base = "";
const got: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    got.push({ body, headers: req.headers });
    if (req.url === "/moved") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
      return res.end();
    }
    res.writeHead(req.url === "/broken" ? 500 : 204);
    res.end();
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("NodeWebhookSender", () => {
  const sender = new NodeWebhookSender();

  it("posts the body and headers given to the server's own network when allowed", async () => {
    expect(await sender.post(`${base}/hook`, '{"a":1}', { "Ferret-Event": "ping" }, { allowLocal: true })).toEqual({ status: 204 });
    expect(got.at(-1)).toMatchObject({ body: '{"a":1}', headers: { "ferret-event": "ping", "content-type": "application/json", "user-agent": "Ferret-Webhooks/1" } });
    expect(await sender.post(`${base}/broken`, "{}", {}, { allowLocal: true })).toEqual({ status: 500 });
  });

  it("never follows a redirect", async () => {
    const before = got.length;
    expect(await sender.post(`${base}/moved`, "{}", {}, { allowLocal: true })).toEqual({ status: 302 });
    expect(got.length).toBe(before + 1);
  });

  it("refuses private addresses (by literal, or by what a name resolves to) unless allowed", async () => {
    await expect(sender.post(`${base}/hook`, "{}", {}, { allowLocal: false })).rejects.toThrow(/private network/);
    await expect(sender.post(`http://localhost:${base.split(":").at(-1)}/hook`, "{}", {}, { allowLocal: false })).rejects.toThrow(/private network/);
    await expect(sender.post("http://[::1]/hook", "{}", {}, { allowLocal: false })).rejects.toThrow(/private network/);
    await expect(sender.post("ftp://example.com/x", "{}", {}, { allowLocal: false })).rejects.toThrow(/http and https/);
  });
});
