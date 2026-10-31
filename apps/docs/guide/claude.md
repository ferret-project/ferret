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

On a hosted Ferret, API keys (Claude and scripts) may come with some plans only — see [Plan and usage](./plan-and-usage).

## The API

Scripts can use the same key with the REST API at `/api/v1`. The [API reference](/../#/api){target="_self"} (also linked from that
page) lists every endpoint, with a ready-to-copy request in curl, JavaScript or Python and what comes back; find one by
typing part of its name. A few things — managing keys, your sign-in security, [Download everything](./download-everything),
backups — need a real sign-in, not a key.
