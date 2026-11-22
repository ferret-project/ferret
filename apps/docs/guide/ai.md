# AI helpers

Besides reading photos and documents, Ferret's AI can do some of the tidying for you. Each helper needs the AI features
set up on your server (see [AI features](../hosting/ai)); without them, the buttons don't show. Each use counts as an AI
action on a hosted Ferret ([Plan and usage](./plan-and-usage)).

The rule throughout: **the AI suggests, you decide.** The one exception is filling in empty fields, and only if your
household switches it on.

## To confirm {#to-confirm}

**To confirm** (in the menu, and in the bell when something's waiting) gathers what the AI suggested that nobody has
looked at yet, so tidying up after adding things is one list:

- each thing whose photos or receipts say something it doesn't, with **Apply**, **Apply all** and **Dismiss** as on its
  page;
- [replacement-cost estimates](#replacement-cost) not used yet: **Use**, **Use all** or **Not this**;
- links to the other lists with something waiting: details [AI filled in](#let-ai-fill-in), possible duplicates,
  suggested maintenance and documents from Paperless.

![To confirm: a receipt's suggestions with Add the 4 things on this receipt, then AI's replacement-cost estimates, each with Use and Not this](/screenshots/to-confirm-light.webp){.shot .light-only}
![To confirm: a receipt's suggestions with Add the 4 things on this receipt, then AI's replacement-cost estimates, each with Use and Not this](/screenshots/to-confirm-dark.webp){.shot .dark-only}

## Describe it in your own words {#describe-it}

**+ Add → Type it in** has a box at the top: describe the thing as you'd say it — *"DeWalt drill, garage top shelf,
bought last March for $129, tagged DIY"* — and tap **Fill in** (or Enter). The AI fills the name, brand and place, and
shows the rest as chips: model, serial number, how many, the box it's in, its category, tags, when you bought it, what
you paid, a note. Places, boxes, categories and tags come only from your own; one you don't have is left out, never
made up. Tap ✕ on a chip to leave it out, change any field, then **Add**. Where your server has
[speech to text](#saying-it-instead-of-typing), the microphone beside **Fill in** lets you say it instead.

![Add, with Ryobi cordless leaf blower, garage, bought in May for $179 typed in: the name, place and brand filled in, and its category, purchase date and price as chips](/screenshots/describe-light.webp){.shot .light-only}
![Add, with Ryobi cordless leaf blower, garage, bought in May for $179 typed in: the name, place and brand filled in, and its category, purchase date and price as chips](/screenshots/describe-dark.webp){.shot .dark-only}

## Read a label or receipt {#read-a-label}

In a thing's **Edit**, **Read a label or receipt** takes a photo of its rating plate, label or receipt. A few seconds
later what the AI read is in the form: **empty fields are filled in**, and a different value for a field you'd already
filled is offered with **Use**. Nothing is saved until **Save**. The photo stays with the thing's photos.

## Several photos of one thing {#several-photos}

Pick several photos in **Add from photos** and Ferret asks: **Each is a different thing**, or **All of one thing** —
its front, its label, its receipt, together as one new thing. On a [walkthrough](./walkthrough), **Another photo of
the same thing** adds the next photo to the thing you just photographed. The AI reads every photo, and the
suggestions come together: each detail from the photo that read it plainly (the label's *Cordless drill* over the
front's *Tool*).

## A receipt with several things on it {#receipt-lines}

A receipt, invoice or order with several products on it — a Costco run, an Amazon order — lists them under the
thing's suggestions: **Add the other things on this receipt…** Each line comes with its brand, model, how many, its
price and a category; correct any, untick what you don't want (the line that's probably this thing starts unticked),
choose where they are, and **Add**. Each becomes a thing of its own, bought the same day with the receipt's return
window, and gets its own copy of the receipt. A receipt photographed on its own as a *New item* offers **Add the
things on this receipt…** with every line ticked, its own first: the first one ticked becomes that *New item*.
**Not these** stops offering them.

![On this receipt: a blender, a Dutch oven, a scale and two peelers, each ticked, with how many and the price, and Add 4 things](/screenshots/receipt-lines-light.webp){.shot .light-only}
![On this receipt: a blender, a Dutch oven, a scale and two peelers, each ticked, with how many and the price, and Add 4 things](/screenshots/receipt-lines-dark.webp){.shot .dark-only}

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
  name of an unnamed *New item* — a better reading from another of its photos can replace a name the AI gave);
- **Categories**: which of your categories a thing belongs in, from its photos and receipts, when it has none;
- **Return-by dates** from a receipt;
- **Warranties** from a receipt or warranty card, once the purchase date is known.

They're all **off** unless you switch them on. Even then, the AI:

- fills only **empty** fields, never one you typed, and never one you cleared since the file was added;
- fills only what it says it read plainly off the label or receipt; the rest stays a suggestion;
- says so in the thing's history (*Filled in by AI from receipt.pdf: brand DeWalt*).

Each field it filled has a **Filled in by AI** card on the thing's page until someone taps **Looks right** or
**Undo** (or edits that field). **Filled in by AI** (linked from [To confirm](#to-confirm)) lists them all.

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

For many at once, **Estimate values with AI** (under [To confirm](#to-confirm), and on **Everything**'s list of things
without a value) asks about every thing with no value, price paid or replacement cost — up to 50 at a time. The
estimates wait under **To confirm**; **Use** sets the replacement cost, and the value too when it has none.

## Listing text for selling

Selling something? On its page, **Write a listing to sell it** (also under **Sold it** when you mark it sold) drafts
a short ad from what Ferret knows about it — name, brand, model, condition, your description, what its photos show,
what you paid and what it's worth: a **title**, a **description** and a suggested **asking price**, with what the
price is based on. Change anything, then copy each part (or **Copy it all**) into the marketplace you use.

When your server has [eBay listings](past-things#on-ebay-now), what the same thing is listed for on eBay now is shown
under the price.

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

On a [walkthrough](./walkthrough), the microphone beside **What is it?** lets you say the name; in **+ Add → Type it
in**, the one beside **Fill in** lets you [describe the whole thing](#describe-it). Tap, speak, tap again
(it stops by itself after 10 seconds). It shows only when your server has speech to text (`SPEECH_URL`, see
[Configuration](../hosting/configuration)). The recording goes to your server's speech model and isn't kept.
