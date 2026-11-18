# Adding things

## One at a time

![The Add something sheet: type it in, from photos, scan a barcode, walk through a room, import, blank QR labels](/screenshots/add-light.webp){.shot .light-only}
![The Add something sheet: type it in, from photos, scan a barcode, walk through a room, import, blank QR labels](/screenshots/add-dark.webp){.shot .dark-only}

Type a name into **Add an item…** on the home screen (or in a room, a category or a tag, to add it there) and press
Enter. Then fill in what you know on the item's page: brand, model, serial number, where it is, what you paid, what
it's worth, notes.

With the AI features, **+ Add → Type it in** also takes a sentence — *"DeWalt drill, garage top shelf, bought last
March for $129"* — and fills in the fields from it ([Describe it](./ai#describe-it)). In a thing's **Edit**, **Read a
label or receipt** fills them from a photo ([Read a label](./ai#read-a-label)).

## From photos

**Add from photos** takes several photos at once — or pick them from your library — and makes a **New item** for each
(or, for **All of one thing**, one item from all of them: [Several photos of one thing](./ai#several-photos)).
Ferret reads every photo in the background: what it shows, any text on it (a label, a model number), and suggests a
name, details and one of your categories. Those wait on each item, and under [To confirm](./ai#to-confirm), until you
confirm them. A receipt with several things on it offers to [add each of them](./ai#receipt-lines).

Nothing Ferret suggests is saved until you tap it. Each suggestion shows a small picture of the photo or document it
was read from — tap it to see it bigger — so you can tell which photo was which, whatever the phone named it.

## Photos and documents on an item

On an item's page:

- **Photos** — take one with the camera or drop files in.
- **Documents** — receipts, manuals, warranty cards: a PDF, or a photo of the paper. Ferret reads the text, so you can
  search for anything in them, and it suggests details it found — the price and date on a receipt, how long a
  warranty lasts, maintenance a manual recommends.
- **Add from a web address** — paste the address of a photo or a PDF (a product photo, a manual online). Only photos and
  PDFs are accepted, and only from the public internet.

Tap a document to open it in Ferret's own viewer: a PDF page by page, with the magnifiers to zoom, **Share** to save
it to your phone (Files, Books) or send it to another app, and **Close** to come back. On a computer the arrow button
opens it in a browser tab instead. Opened from a [search inside the thing](./finding-things#searching-one-thing), a
manual opens at the page that matched, with your words highlighted.

Tap a photo to see it **full screen**: swipe (or ‹ › and the arrow keys) between photos, double-tap — or **+** — to zoom
in and drag to look around (handy for a serial number), and open the original to save it. Its caption is what Ferret
read off it.

**Crop a photo** to just the thing — one item on a busy shelf, a label: tap the crop button on its top-left corner, drag
the box onto it and its corners to fit (tick **Square** for how photos show in lists), and **Save crop**. The crop is
added as a new photo and, unless you untick it, becomes the **main photo** — the thing's picture in lists, marked
**Main** on its page. The original stays. To make any photo the main one as it is, open the same button and tap **Use as
main photo, uncropped**. A crop keeps what Ferret read in the original, so removing the original afterwards loses
nothing.

After **Take photo** or **Scan document**, Ferret shows the photo before adding it: **Use photo** as it is, drag the
corners in and **Use crop** to keep just part of it, or **Retake**. A photo that was never read (added before AI was set
up, say) has a ✨ button to have Ferret read it.

Uploads are encrypted on the server.

## By barcode

Tap the **barcode** button next to the search box and point the camera at a barcode. If you already have something
with that barcode, Ferret opens it. If not, it suggests a name — from things your household saved before, or from an
online product database if whoever runs Ferret turned that on — and you can add it.

## Links

An item can keep web links: the maker's product page, the manual online, where you bought it. YouTube videos about it
go in its **How-to videos** instead (**How-to video** on its page), where they play inside Ferret — see
[How-to videos](./maintenance#videos).

## Scanning a barcode

**+ Add → Scan a barcode** opens the camera. If Ferret knows the code — someone in your household saved something with
it before, or the online product database has it — it offers the name, brand and model to add in one tap.

If you **already have it**, Ferret says so instead of making a second one: **Add 1 (now 3)** puts one more on the
count of the thing you have (it shows in its history), and **Add as a separate item** makes a new one — say, the same
drill for the cabin. If several of your things have that code, pick which one to add to.

## Books

A book's barcode is its **ISBN**. When whoever runs your Ferret has switched on
[book look-ups](../hosting/server-admin#book-look-ups), scanning it (or saving a thing with it) asks Open Library, and
Ferret offers the **title** and **author** — the author goes in the brand — and the **cover** as a photo, like any
barcode's suggestions.

## Several of the same

Bought three of something, like a TV box for each room? Usually each should be its own thing, with its own serial
number, place, label and pairing code. On the first one's page, tap **Add another like this**. The editor opens with
the same name, brand, model, barcode, category, tags, price and purchase details. Serial number, place, notes, photos
and labels start empty. Fill in what's different and tap **Add it**.

When the barcode button next to the search box opens a thing you already have, its page asks **Is this a different
one?** and has the same **Add another** button.

## Where it came from

Each thing's page says when it was added, by whom, and how: in the app, with **Add from photos**, on a
[walkthrough](./walkthrough), by scanning its barcode, from a [QR label](./labels), from a receipt with several things on
it, by describing it in words, from a spreadsheet or Home Assistant
[import](./importing) (with the file's name), by Claude, or by a script — with the name of the API key it used.

To see everything added one way — say, **what Claude added**, to check its work — use **Where from** on the
**Everything** list, or tap the "by Claude" on any thing's page. Claude can list its own additions too.
