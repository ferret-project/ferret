# Recalls

Ferret can check your things against product recalls — the US Consumer Product Safety Commission's list — every day,
and tell you when something you own may be recalled. (Whoever runs your Ferret switches it on; see
[the server admin](../hosting/server-admin#recall-checks).)

## How it matches

It looks at each thing's **brand**, **model** and **barcode**, so the more of those you've filled in (a photo of the
label does it), the better it works:

- **Recalled** — the barcode is on the recall, or the brand and model number are. That's the same product: the recall
  is shown in red, at the top of the dashboard, on the thing's page, and in the bell and the daily reminder.
- **Possibly recalled — check the model** — the same maker and the same kind of thing (a DeWalt drill, a DeWalt drill
  recall), but no model number to be sure. Look at the recall notice and compare the model on the label.

## What to do

On the thing's page, the recall says what the hazard is and what to do (usually: stop using it, contact the maker for
a repair, replacement or refund), with a link to the full notice. Then:

- **Not mine** — a different model, or it doesn't apply: it goes away and isn't offered again.
- **Dealt with it** — repaired, replaced or refunded: it goes away.

Either way the thing's [history](./finding-things#a-thing-s-history) keeps it.
