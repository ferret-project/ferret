# AI helpers

Besides reading photos and documents, Ferret's AI can do some of the tidying for you. Each helper needs the AI features
set up on your server (see [AI features](../hosting/ai)); without them, the buttons don't show. Each use counts as an AI
action on a hosted Ferret ([Plan and usage](./plan-and-usage)).

The rule throughout: **the AI suggests, you decide.** The one exception is filling in empty fields, and only if your
household switches it on.

## Reading a photo or document again

If the AI got a photo wrong, or your server has a better model now, tap the sparkles in the corner of the photo on the
thing's page (**Analyze again**); a document has a refresh button (**Read it again**). Its suggestions come back fresh,
even ones you dismissed, and it counts as an AI action again. Files whose original was removed to save space (only the
small copy is kept) can't be read again.

For many at once, tick them in **Everything**'s table and choose **Analyze**: it reads only what hasn't been read yet
(or couldn't be), and leaves the rest alone ([Changing many things at once](./finding-things#changing-many-things-at-once)).

## Let AI fill in

Normally what the AI reads from a photo or receipt waits on the thing's page as a suggestion, for you to apply. Under
**Settings → Household → Let AI fill in** an owner or admin can let some kinds fill in by themselves:

- **Details from photos and receipts**: brand, model, serial number, barcode, purchase date and price paid (and the
  name of an unnamed *New item*);
- **Return-by dates** from a receipt;
- **Warranties** from a receipt or warranty card, once the purchase date is known.

They're all **off** unless you switch them on. Even then, the AI:

- fills only **empty** fields, never one you typed, and never one you cleared since the file was added;
- fills only what it says it read plainly off the label or receipt; the rest stays a suggestion;
- says so in the thing's history (*Filled in by AI from receipt.pdf: brand DeWalt*).

Each field it filled has a **Filled in by AI** card on the thing's page until someone taps **Looks right** or
**Undo** (or edits that field). **Filled in by AI** in the menu lists them all.

It never: merges duplicates, sets a value or replacement cost, renames something you named, marks things gone, adds
maintenance, or sends anything outside Ferret.

Whoever runs the server can make kinds **on by default** for its households (Settings → Server → Let AI fill in, by
default). A household's own choice wins, and **Use the server's default** hands a kind back.

## Suggested maintenance

Upkeep read from a thing's manual collects on the **Maintenance** screen under **Suggested maintenance**, and on the
thing's page. **Add** opens the task filled in, so you can adjust it first. **Not needed** is remembered.

**Suggest typical upkeep for my things** asks the AI what things like yours usually need: a furnace's filter, a water
heater's flush, a dryer's vent. Most things need none. These say *typical for things like it*: check the manual. Each
thing is only asked about once; a thing's page has **Suggest typical upkeep** too, under **Maintenance** (tap **Maintenance** below the photos if it has none yet). See [Maintenance](./maintenance).

## Suggested parts

A manual's parts list and accessories are read too: the parts you'll buy again (bags, filters, belts, blades…) are
offered on the thing's page under **Parts & supplies**, with their part numbers. **Add** makes each a thing of its own;
nothing is added by itself. See [Parts and supplies](./stock#parts-and-supplies).

## Sorting an import

When you [import a spreadsheet](./importing#a-spreadsheet-csv), an Amazon order history especially, **Sort with AI**
reads the lines' names. It unticks the ones that look like consumables or not worth a record (groceries, batteries,
cables, digital purchases), and picks a category for each line from **your own** categories (never a new one). Only
the names are sent. Check the list and tick anything it got wrong before **Import**.

## Describe what you're looking for

On **Everything**, type what you want in plain words: *tools bought last year over $100*, *electronics in the garage
without a receipt*, *not scanned in a year*. Ferret turns it into the list's filters, from your own categories, places
and tags. Chips show the ones the filter bar has no control for, so you can change or remove each. The AI doesn't
answer by itself; it only sets the filters. Plain search is unchanged.

## Replacement cost

On a thing's page, **Estimate replacement cost** asks the AI what a new one of like kind would cost today, with its
reasoning. It's always an **estimate**: check a current price. **Use** puts it in the thing's replacement cost (or type
your own in **Edit → To replace new**). The [insurance report](./insurance-report) and its spreadsheet show it beside
the value.

## Listing text for selling

Selling something? On its page, **Write a listing to sell it** (also under **Sold it** when you mark it sold) drafts
a short ad from what Ferret knows about it — name, brand, model, condition, your description, what its photos show,
what you paid and what it's worth: a **title**, a **description** and a suggested **asking price**, with what the
price is based on. Change anything, then copy each part (or **Copy it all**) into the marketplace you use.

It's a draft: check it against the thing itself. Nothing is saved or posted anywhere, and your notes and its serial
number are never sent to the AI. Each draft counts as one question on your plan.

## Possible duplicates

**Possible duplicates** (in the menu, and the bell when there are some) lists things that may be the same thing twice:
the same serial number, the same barcode and name, or names and descriptions that read alike (*Drill* and *DeWalt
cordless drill*).

**Merge…** shows the two side by side. Choose which one to keep and, where they differ, which value to use. Everything
moves to the one kept: photos, documents, warranties, maintenance, stock, labels, loans, tags and history. The other
goes to [Recently deleted](./recently-deleted), and its old links lead to the one kept. **Not a duplicate** is
remembered. Nothing is ever merged by itself.

## Ready for a claim

Things worth $200 or more without a serial number show under **Ready for a claim?** on the home screen, and once in the
bell. Insurers ask for serial numbers first. Photograph the label or serial plate and the AI reads it.

## Saying it instead of typing

On a [walkthrough](./walkthrough), the microphone beside **What is it?** lets you say the name. Tap, speak, tap again
(it stops by itself after 10 seconds). It shows only when your server has speech to text (`SPEECH_URL`, see
[Configuration](../hosting/configuration)). The recording goes to your server's speech model and isn't kept.
