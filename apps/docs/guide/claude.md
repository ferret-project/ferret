# Claude and the API

## Claude

Ferret speaks **MCP**, so Claude can look things up and keep your inventory up to date for you: *"where did we put the
tent?"*, *"add the new blender, it was $89 at Target"*, *"what maintenance is due this month?"*, *"we used the last
furnace filter"*.

1. **Household & settings → Claude & API → New key.** Name it, choose whether it's **read-only** (can look and ask, but
   not change anything) and when it expires.
2. Copy the key straight away — Ferret only shows it once.
3. Connect Claude Code with the command shown there:

   ```bash
   claude mcp add --transport http ferret https://ferret.example.lan/mcp --header "Authorization: Bearer ferret_…"
   ```

A key works for one household, acts as you, and can be revoked any time from the same page.

### Claude Desktop

Claude Desktop starts its MCP servers as programs on your computer, so it reaches Ferret through Ferret's small
**bridge**, which passes each message on to your Ferret with your key. It needs [Node.js](https://nodejs.org) 26 or
newer.

1. Save the bridge somewhere it can stay, e.g. a `ferret` folder in your home folder:

   ```bash
   mkdir -p ~/ferret && curl -o ~/ferret/bridge.mjs https://raw.githubusercontent.com/ferret-project/ferret/main/contrib/mcp-bridge/bridge.mjs
   ```

2. In Claude Desktop, **Settings → Developer → Edit Config** opens `claude_desktop_config.json`. Add Ferret, with your
   Ferret's address and the key:

   ```json
   {
     "mcpServers": {
       "ferret": {
         "command": "node",
         "args": ["/Users/you/ferret/bridge.mjs"],
         "env": {
           "FERRET_URL": "https://ferret.example.lan",
           "FERRET_API_KEY": "ferret_…"
         }
       }
     }
   }
   ```

   Use the full path to `bridge.mjs`. On Windows, double each backslash, as JSON needs:
   `"C:\\Users\\you\\ferret\\bridge.mjs"`.

3. Quit Claude Desktop completely and open it again. Ask *"what's in the garage?"* to try it.

If it doesn't show up:

- **Claude Desktop can't find Node** (common on a Mac with Node from Homebrew): put its full path as `"command"` —
  `which node` in a terminal prints it, e.g. `/opt/homebrew/bin/node`.
- **Your Ferret's certificate is from your own authority** (a LAN address): add
  `"NODE_EXTRA_CA_CERTS": "/path/to/your-ca.pem"` to `env`.
- **Settings → Developer** shows whether Ferret is running, and opens its log.

Claude's **Connectors** (Settings → Connectors → Add custom connector) need a sign-in Ferret doesn't offer yet; use
the config file above.

### What Claude can do

With a full key, Claude can find things (by words and meaning, and from receipts and manuals), look at an item's
photos, add and change things — one at a time or many at once — and look after places, categories, QR labels,
warranties and claims, maintenance, recalls, stock and the shopping list, lending, collections, insurance limits,
and [room reviews](./room-review) (*"found the passport"*, *"let's go through the garage"*).
With a **read-only** key it only gets the tools that look and ask. A few things stay in the app: managing keys,
members and invitations, share links, pairing codes, settings and backups.

Claude asks before deleting anything, deleted things wait 30 days in [Recently deleted](./recently-deleted), and
suggestions read from photos and documents are applied only once you've said yes.

### Other MCP clients

Ferret's MCP server is at `/mcp` on your Ferret's address (Streamable HTTP). Clients that can send a header take the
address and the key — as `Authorization: Bearer ferret_…` or `X-API-Key: ferret_…`:

```json
{
  "mcpServers": {
    "ferret": {
      "type": "http",
      "url": "https://ferret.example.lan/mcp",
      "headers": { "Authorization": "Bearer ferret_…" }
    }
  }
}
```

Clients that only start a local program and talk to it over stdio — Docker's MCP Toolkit, desktop apps' config files —
can use the small bridge in
[`contrib/mcp-bridge`](https://github.com/ferret-project/ferret/tree/main/contrib/mcp-bridge): it runs with Node or
Docker, takes `FERRET_URL` and `FERRET_API_KEY`, and forwards each message to your Ferret. It holds nothing itself.

Ferret is listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.ferret-project/ferret`,
so directories built on it can find it; you fill in your Ferret's address and a key.

On a hosted Ferret, API keys (Claude and scripts) may come with some plans only — see [Plan and usage](./plan-and-usage).

## The API

Scripts can use the same key with the REST API at `/api/v1`. The [API reference](../api/) (also linked from that
page) lists every endpoint, with a ready-to-copy request in curl, JavaScript or Python and what comes back; find one by
typing part of its name. A few things — managing keys, your sign-in security, [Download everything](./download-everything),
backups — need a real sign-in, not a key.

The API is also described as **OpenAPI 3.1** at `/api/v1/openapi.json` — import it into
Postman, Bruno or Insomnia, or generate a client from it.

## Other ways to connect

| To… | Use |
| --- | --- |
| Show counts on a home dashboard (Heimdall, Homepage) | `GET /api/v1/summary` — [Home dashboards](../hosting/dashboards) |
| Get maintenance in a calendar app | the calendar feed — [Reminders](./reminders#calendar) |
| Send reminders to ntfy, Pushover, Telegram… | [Other apps](./reminders#other-apps) |
| Bring in devices and rooms from Home Assistant | [Importing](./importing#home-assistant) |
| Load or move things in bulk | a spreadsheet, [importing](./importing#a-spreadsheet-csv) and the [insurance report's CSV](./insurance-report) |
| Take everything with you | [Download everything](./download-everything): JSON, CSV and the files |
