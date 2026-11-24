# QR labels and NFC tags

Stick a QR label on a box, a shelf or a door and scan it with any phone camera: it opens that box or place in Ferret.
Scanning a thing's label counts as [seeing it](./room-review#last-seen): its page says when, and by whom.
The labels also tell Ferret where things go: scan a shelf's label while editing a thing, or **Move things here**
and scan what you put there — see [Moving things by scanning](./places-and-boxes#scan).

## Printing

![The label print page: choose the sheet, and a preview of the labels laid out on it](/screenshots/labels-light.webp){.shot .wide}

- From a **thing, box or room**: the label badge beside its name → **Print**. A thing keeps its label: printing it
  again always gives the same code, so a reprint replaces a worn label without changing anything.
- **QR labels** in the menu prints a whole sheet, including **blank labels** to stick on first and connect later.

Sheets are laid out for **Avery 5163** (2″ × 4″) and **5160** (1″ × 2⅝″) labels, the square **22806** (2″) and
**22805** (1½″) — handy for bins and jars — or plain paper to cut up. Print at **100% / actual size**
(not "fit to page"), and see **Printing tips and alignment** on the print page if they don't line up.

Using up a **part-used sheet**? Set **Skip the first … labels** to how many are gone: printing starts after them (the
preview greys them out).

## Label printers

Have a **Brother** (QL or P-touch), **Dymo LabelWriter** or another thermal label printer? Pick its label under
**Labels** — Brother DK-1201, DK-1209, DK-1208, DK-11204, DK-11221, DK-1202, or 62 mm or 29 mm continuous; P-touch 12,
18 or 24 mm tape; Dymo 30252, 30336, 30334, 30332, 30330, 30256 or the 5XL's 4″ × 6″; or a 2″ × 1″, 1½″ × 1″,
2¼″ × 1¼″ or 4″ × 6″ thermal label. Each label is laid out at exactly that size — the QR beside
the code on long labels, above it on square ones — one label per page. Then **Print**, and in the print dialog choose
the label printer, its label size, scale 100% and no margins. (The printer's driver needs to be installed on that
computer; if a label comes out sideways, switch Landscape/Portrait.)

## Blank labels

Scan a blank label and Ferret asks **What did you stick it on?** — pick the box or place, and from then on it opens it.
A label can be taken off and reused.

Blank labels are kept until they're stuck on something, so a sheet that jammed or a print that failed isn't lost:
**QR labels** → **Print the unused blank labels again** prints every one not used yet (the history's *Made 12 blank
labels* line leads there too).

## Labels you already have

Already have asset tags, or QR stickers from another app? Open the label badge on a thing or box → **Use a label you
already have**, and **Scan it** (or type its code). From then on, scanning that sticker opens the thing, just like
Ferret's own labels — and its code finds it in search. A code that's already on something else is refused, with a link
to whatever has it. Scanning a sticker Ferret doesn't know yet also offers **It's a label — put it on something I
have**. (Rooms take Ferret's own labels.)

## NFC tags {#nfc-tags}

A label can also be an **NFC sticker**: tap it with a phone and it opens the thing, box or place, the same as
scanning its QR code (and it counts as seeing it). This is handy where a QR code is hard to scan, for example inside
a cupboard, on the underside of a shelf, or somewhere the print would wear off.

1. Get **NTAG213, NTAG215 or NTAG216** stickers (any of them fits a Ferret link). On metal, use "on-metal" or
   "anti-metal" tags: ordinary ones don't read there.
2. Open the label badge on a thing, box or room → **Copy link for an NFC tag**.
3. In any NFC writer app on your phone, write the link to the sticker as a **URL / link** record. Some apps can lock
   the tag afterwards so nobody can write over it. Only do that once it works, because a locked tag can't be changed.

**Reading them:** an **iPhone XS or newer** reads link tags by itself while it's unlocked: hold the top of the phone
near the tag and tap the notification that appears. Older iPhones need **NFC Tag Reader** in Control Center. On
**Android**, turn NFC on and tap the tag. Either way, the link opens in the phone's browser (not the app on the Home
Screen), so you need to be signed in to Ferret there.

The link holds your server's address, so copy it from the address the phones use, the same as for QR labels.
If that address changes, write the tags again. Taking a label off stops its NFC tag from opening the thing too, and
the tag becomes a blank label: tapping it asks what it's on.

Each label is a short code (like `K7QM2X`); someone outside your household who scans it gets nothing but a sign-in page.
