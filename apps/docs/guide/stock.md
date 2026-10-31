# Stock: scan to count

For things you keep a supply of — furnace filters, batteries, light bulbs, water-softener salt, printer ink — Ferret can
keep count. Scan the box when you take one, and the count goes down; scan the case when you bring a new one home, and it
goes up.

## Turning it on for an item

On the item's page, **Track stock**. The **Stock** card shows how many there are, with **−** and **+** to change it by
hand, and **When it's scanned** — what scanning each of its codes does:

| Setting | A scan… |
|---|---|
| **Use (take out)** | takes some out — 1, or as many as you set |
| **Restock (put in)** | puts some in — set it to 12 for a 12-pack's barcode |
| **Ask each time** | asks: use, add, or open the item |
| **Just open it** | opens the item, as an ordinary barcode does |

**Count with its barcode** and **Count with its QR label** add the item's own codes in one tap; **Another code** adds
any other — type it, or tap the barcode button to scan it. A [QR label](./labels) on a bin works too: stick one on the
spare-batteries bin and scanning it takes a pack out.

## Scanning

The **barcode** button next to the search box opens the scanner. Along its top:

- **Auto** — each code does what it's set to (codes with no setting open their item).
- **Look up** — every scan opens what's scanned.
- **Use** / **Restock** — every scan takes one out / puts some in, whatever the code is set to. Handy for unpacking
  a shopping trip.

The choice stays while Ferret's open. When a scan changes a count, the camera keeps going: you get a beep (and a buzz,
on phones that do it) and a note — *Furnace filter: −1 · 3 left* — with **Undo**. Scan the next thing straight away.

If the same barcode is on more than one item — spares in the garage *and* the basement — Ferret asks which, with the
one you picked last at the top.

Counts never go below 0: if there's none left, the scan says so and changes nothing.

## Shopping list

![The shopping list: what's run out, with Bought to put it back in stock](/screenshots/shopping-light.webp){.shot .light-only}
![The shopping list: what's run out, with Bought to put it back in stock](/screenshots/shopping-dark.webp){.shot .dark-only}

**Shopping list** (in the menu, or **To buy** on the home screen) lists what to buy:

- anything you track (it has a code, or its count has changed) that has **run out**, and
- anything at or below its **Keep at least** — set it on the Stock card (*keep at least 2 furnace filters*). Leave it
  blank to list it only when it runs out.
- parts that [maintenance](./maintenance#parts-it-uses) due in the next month needs and there aren't enough of.

Run-out things come first. Each shows how many are left and how many to buy — a suggestion (a restock barcode's pack
size, or enough to get back above the minimum) you can change with **−** and **+**. In the shop, tick things as they go
in the trolley, then **Bought these** adds them all to stock and takes them off the list. Where Ferret knows what one
cost last time (its price paid, or its value), the list shows a rough total. **Copy list** and **Share** send it as
text — to a message, Notes, Reminders. Restocking by scan takes things off by itself.

When something has run out, the bell says so and it's in the [daily reminder](./reminders).

## History

The **History** on the Stock card lists every change — scanned, by hand, by editing the item's quantity, or undone — with
who and when. Anything but an edit can be undone.

People with the **viewer** role can scan to look things up, but not change counts. Claude can too — *"we used the last
AA pack"* (see [Claude and the API](./claude)).
