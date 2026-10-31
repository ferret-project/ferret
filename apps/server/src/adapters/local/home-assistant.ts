/**
 * Home Assistant's registries over its WebSocket API (`/api/websocket`): sign in with a long-lived token, ask for
 * floors, areas, devices and config entries, close. The address is the household's own HA — usually on the LAN —
 * so only the WebSocket protocol is spoken to it, and an answer that isn't Home Assistant's is refused.
 */
import { type HaRegistry, type HomeAssistant, HomeAssistantError } from "../../ports";

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 30 * 1024 * 1024;

const QUERIES = {
  floors: "config/floor_registry/list",
  areas: "config/area_registry/list",
  devices: "config/device_registry/list",
  configEntries: "config_entries/get",
} as const;

/** http(s)://host[:port][/path] → ws(s)://host[:port]/api/websocket (HA behind a path prefix keeps it). */
export function websocketUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HomeAssistantError("That isn't a web address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HomeAssistantError("Use Home Assistant's http:// or https:// address");
  if (url.username || url.password) throw new HomeAssistantError("Leave the user name and password out of the address — the token signs in");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api(\/websocket)?$/, "");
  return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}${path}/api/websocket`;
}

export class HomeAssistantWebSocket implements HomeAssistant {
  registry(address: string, token: string): Promise<HaRegistry> {
    const url = websocketUrl(address);
    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        reject(new HomeAssistantError("That isn't an address Ferret can reach"));
        return;
      }
      const results: Partial<Record<keyof typeof QUERIES, unknown>> = {};
      const ids = Object.keys(QUERIES) as (keyof typeof QUERIES)[];
      let received = 0;
      let greeted = false;
      let done = false;
      const finish = (error?: Error, value?: HaRegistry) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        if (error) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(() => finish(new HomeAssistantError("Home Assistant didn't answer in time")), TIMEOUT_MS);
      socket.addEventListener("error", () =>
        finish(new HomeAssistantError(greeted ? "Home Assistant closed the connection" : "Couldn't reach Home Assistant at that address")),
      );
      socket.addEventListener("close", () => finish(new HomeAssistantError(greeted ? "Home Assistant closed the connection" : "Couldn't reach Home Assistant at that address")));
      socket.addEventListener("message", (event) => {
        const text = typeof event.data === "string" ? event.data : "";
        received += text.length;
        if (received > MAX_BYTES) return finish(new HomeAssistantError("Home Assistant's answer was too big"));
        let msg: { type?: string; id?: number; success?: boolean; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(text);
        } catch {
          return finish(new HomeAssistantError("That doesn't look like Home Assistant"));
        }
        if (!greeted) {
          if (msg.type !== "auth_required") return finish(new HomeAssistantError("That doesn't look like Home Assistant"));
          greeted = true;
          socket.send(JSON.stringify({ type: "auth", access_token: token }));
          return;
        }
        if (msg.type === "auth_invalid") return finish(new HomeAssistantError("Home Assistant didn't accept that token"));
        if (msg.type === "auth_ok") {
          ids.forEach((name, i) => socket.send(JSON.stringify({ id: i + 1, type: QUERIES[name] })));
          return;
        }
        if (msg.type !== "result" || typeof msg.id !== "number") return;
        const name = ids[msg.id - 1];
        if (!name) return;
        if (!msg.success) {
          // Floors arrived in HA 2024.4; an older one just has none.
          if (name === "floors") results.floors = [];
          else return finish(new HomeAssistantError(`Home Assistant refused to list its ${name === "configEntries" ? "integrations" : name} — use an administrator's token`));
        } else results[name] = msg.result;
        if (ids.every((n) => Array.isArray(results[n]))) finish(undefined, results as HaRegistry);
      });
    });
  }
}
