# Webhooks

A webhook tells another app when something happens in your household: a thing is added, sold or running low, or
maintenance is due. Ferret POSTs a small JSON message to an address you give it, such as an **n8n** workflow, a
**Home Assistant** automation or your own script.

## Adding one

**Household & settings → Claude & API → Webhooks → Add** (the household's owner and admins only).

1. Give it a name and the address to post to.
2. Tick the events it should hear about (below).
3. **Add**. Ferret then shows the webhook's **signing secret**. Give it to the receiver so it can
   [check that a delivery really came from your Ferret](#checking-the-signature). **Show secret** shows it again later.

**Send a test** posts a `ping` event straight away and tells you how the receiver answered.

The address is kept encrypted, and afterwards Ferret only shows its host, because addresses often carry a token
(n8n's and Home Assistant's do).

### Addresses on your own network

Only **whoever runs your Ferret** (the server admin, Settings → Server) can point a webhook at an address on the
server's own network, such as `http://homeassistant.local:8123/…`, `http://10.0.0.5:5678/…` or a name that leads there.
Anyone else can only use internet addresses. This stops one household on a shared server from reaching into the
network it runs on. A Ferret run as a service for you can only post to internet addresses.

## Events

| Event | When |
| --- | --- |
| `item.created` | A thing is added |
| `item.updated` | A thing is changed (`summary` says what changed, in the words its history uses) |
| `item.gone` | A thing is marked sold, given away, donated, thrown out, lost or stolen |
| `item.deleted` | A thing is deleted |
| `items.imported` | Things were imported (one event per batch, not one per thing) |
| `stock.low` | A count falls to its "keep at least", or runs out, so it's on the shopping list |
| `task.due` | Maintenance is due within a week (or a month, if you're short of the part it uses) |
| `task.overdue` | Maintenance is past its day |
| `warranty.ending` | A warranty ends within 30 days |
| `support.ending` | A tracked device's [security updates stop](./replacements#software-updates) within 90 days (or stopped in the last 30) |
| `return.closing` | A return window closes within a week |
| `recall.found` | A product recall matches one of your things |
| `loan.due` | Something you borrowed is due back within 3 days, or something you lent is past its day |

Changes are sent as they happen. The rest (due, ending, closing, found) are checked every hour and each is sent
**once**, when it first needs attention. If a task is moved to another day and comes due again, it's sent again.

## What's sent

```json
{
  "id": "6a1c0f9e-2b4e-4d7a-9a51-8f3c2d1e0b77",
  "type": "item.created",
  "version": 1,
  "createdAt": "2026-11-15T14:02:11.311Z",
  "household": { "id": "usQNAEYn…", "name": "Our house" },
  "data": {
    "item": {
      "id": "43bec8cd-4c21-4daf-8dfc-75b08cb7f1b6",
      "name": "Cordless drill",
      "brand": "DeWalt",
      "model": "DCD791",
      "quantity": 1,
      "location": { "id": "…", "path": "Home › Garage › Shelf" },
      "containerItemId": null,
      "categoryId": "…",
      "valueCents": 12900,
      "currency": "USD",
      "disposition": null,
      "url": "https://ferret.example.com/#/items/43bec8cd-…"
    }
  }
}
```

- `id` is the event's own id. A retried delivery carries the same one, so **ignore an id you've already handled**.
- `version` changes only if the format changes in a way a receiver would notice.
- Messages hold ids, names and a few plain details, plus links into Ferret. They **never hold notes**. To read more,
  call the [API](/api/) with a key.
- `stock.low` adds `quantity`, `minQuantity` and `out`. `item.gone` adds `disposedOn`. The "needs attention" events
  carry a `title` and `detail` (the bell's words), a `date`, and the thing they're about.

Each request also has these headers:

| Header | |
| --- | --- |
| `Ferret-Event` | The event's type, e.g. `item.created` (`ping` for a test) |
| `Ferret-Event-Id` | The event's `id` |
| `Ferret-Delivery` | This delivery's id (each retry of it has the same one) |
| `Ferret-Signature` | `t=<unix time>,v1=<signature>` ([below](#checking-the-signature)) |

## Checking the signature

`v1` is the HMAC-SHA256, in hex, of the time, a dot and the raw body (`<t>.<body>`), keyed with the webhook's secret.
Check it against the body exactly as it arrived, before parsing it. Also refuse a `t` that's more than a few minutes
old, so an old delivery can't be replayed. For a day after you **Rotate** the secret, the header carries a second `v1`
made with the old secret. Accept the delivery if either one matches.

```js
// Node.js
import { createHmac, timingSafeEqual } from "node:crypto";

function fromFerret(rawBody, header, secret) {
  const parts = header.split(",").map((p) => p.split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  return parts.some(([k, v]) => k === "v1" && v.length === expected.length && timingSafeEqual(Buffer.from(v), expected));
}
```

```python
# Python
import hashlib, hmac, time

def from_ferret(raw_body: bytes, header: str, secret: str) -> bool:
    parts = [p.split("=", 1) for p in header.split(",")]
    t = next((v for k, v in parts if k == "t"), None)
    if not t or abs(time.time() - int(t)) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(k == "v1" and hmac.compare_digest(v, expected) for k, v in parts)
```

## Deliveries and failures

A delivery has worked when the receiver answers with a **2xx** status. Anything else, or no answer within 15 seconds,
is tried again a few more times over the next quarter of an hour. Redirects aren't followed. Open a webhook to see
its **recent deliveries** (the last 50, kept 30 days), why each one failed, and **Retry** a failed one with the same
event id.

If **5 deliveries in a row** fail every try, Ferret **switches the webhook off** and the bell tells the household's
owner and admins. Fix the address (**Change**), then **Turn on**. **Pause** stops a webhook for a while. Nothing that
happens while it's paused is kept to send later.

## n8n

::: v-pre
1. Add a **Webhook** node: HTTP Method **POST**, and under Options turn on **Raw Body** if you'll check the signature.
2. Copy its **Production URL** into Ferret and activate the workflow. (The test URL only works while n8n is listening
   for a test event. Use it with **Send a test**.)
3. Branch on `{{ $json.body.type }}`, e.g. with a **Switch** node: `stock.low` → add to your shopping list app,
   `task.overdue` → a message to your phone.

To check the signature, add a **Crypto** node (Action: **Hmac**, Type **SHA256**, Encoding **hex**) that signs
`{{ $json.headers["ferret-signature"].split(",")[0].slice(2) }}.{{ the raw body }}` with the secret. Then add an **If**
node that compares the result with the header's `v1`.
:::

## Home Assistant

Home Assistant can start an automation from a webhook. Its webhook id is the secret in the address, and Home
Assistant doesn't check signatures. Pick a long, random id, and keep **Only accessible from the local network** on if
your Ferret is on the same network.

```yaml
alias: Ferret — put low stock on the shopping list
triggers:
  - trigger: webhook
    webhook_id: ferret-k3v9q2m8x7    # make your own
    allowed_methods: [POST]
    local_only: true
conditions:
  - condition: template
    value_template: "{{ trigger.json.type == 'stock.low' }}"
actions:
  - action: todo.add_item
    target:
      entity_id: todo.shopping_list
    data:
      item: "{{ trigger.json.data.item.name }}"
```

The address to give Ferret is `http://homeassistant.local:8123/api/webhook/ferret-k3v9q2m8x7`. It's on your own
network, so [whoever runs your Ferret](#addresses-on-your-own-network) has to add it.
