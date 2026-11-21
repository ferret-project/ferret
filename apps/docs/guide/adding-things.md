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
it before, or the online product database has it — it offers the name, brand and model to add in one tap. Groceries,
cleaning supplies, batteries, light bulbs and toiletries are also looked up on
[Open Food Facts](https://openfoodfacts.org) and its sister databases, when whoever runs your Ferret has switched
[that](../hosting/server-admin#groceries-and-household-goods) on. These are the things people scan to keep
[stock](./stock) and the shopping list.

If you **already have it**, Ferret says so instead of making a second one: **Add 1 (now 3)** puts one more on the
count of the thing you have (it shows in its history), and **Add as a separate item** makes a new one — say, the same
drill for the cabin. If several of your things have that code, pick which one to add to.

## Books

A book's barcode is its **ISBN**. When whoever runs your Ferret has switched on
[book look-ups](../hosting/server-admin#book-look-ups), scanning it (or saving a thing with it) asks Open Library (and,
if it doesn't know the book, Google Books when your server has its key), and Ferret offers the **title** and **author** — the author goes in the brand — and the **cover** as a photo, like any
barcode's suggestions.

Older books, printed before ISBNs, have no barcode: **+ Add → Books by title** finds them on Open Library by title and
author (*Little Women Alcott*), or from a photo of the cover, spine or title page. It works like the
[collector catalogs](#lego-coins-and-comics): check the list, then save them all, each with its author, first year
published and cover, and a link back to Open Library.

## Music

Got a shelf of CDs or a crate of records? When whoever runs your Ferret has switched on
[music look-ups](../hosting/server-admin#music-look-ups), **+ Add → Scan music** scans them one after another: tap
**Start scanning** and go through the barcodes on the back. The camera keeps going, beeping for each one, and Ferret
looks each up on [MusicBrainz](https://musicbrainz.org) while you carry on. Tap **Done** when you're through the pile.

Then check the list. Each album shows its **cover**, **artist**, and format, year and label (*CD · 1997 · Capitol
Records*). Untick any you don't want, or remove them with **✕**. One MusicBrainz doesn't know can still be added: type
its name. One you **have already** is listed but left unticked, so it isn't added twice. Choose **where they are** and a
**category** (Ferret picks your "Music" category if you have one), then **Save**. Each becomes a thing: the album is its
name, the artist its brand, format · year · label its description, and the cover its photo (untick **Add each album's
cover** to skip those).

Nothing is added until you save, and the list survives the page reloading. When a barcode belongs to several pressings
(reissues often share one), Ferret takes the earliest official one; the description shows which.

## Trading cards

Pokémon and Magic: The Gathering cards have no barcode, so **+ Add → Scan cards** reads them instead. It's there when
whoever runs your Ferret has switched on [card look-ups](../hosting/server-admin#trading-cards). Pick the game at the
top, then:

- **Photograph a card**: front on, filling the photo. Ferret reads its name and number while you take the next one.
  **Choose photos** reads several you've already taken. Each photo counts as an AI action.
- **Or type it**: the name, and the number if you know it (*Pikachu 025/165*, *Lightning Bolt M10 146*). Then tap the
  right card.

Each card comes up with its picture, set, number, rarity and **today's market price**. Pokémon prices come from
[TCGdex](https://tcgdex.dev) and Magic prices from [Scryfall](https://scryfall.com): TCGplayer's price in dollars,
Cardmarket's in euros. In any other currency they're converted (≈) when whoever runs your Ferret has switched on
[exchange rates](../hosting/server-admin#exchange-rates). Check the list:

- **Not this printing?** shows the other cards with that name and number (reprints, promos). Pick yours.
- Choose the **finish** you have (Normal, Holofoil, Reverse holofoil, Foil…), since the price depends on it.
- **+ / −** sets how many. The same card again adds to its count instead of making another.

Choose a **collection**, category and place, then **Save**. Each card becomes a thing: its name, the game as the brand,
set and number as the model, and the card's own picture as its photo. Today's price becomes its value unless you
untick **Use today's market price**. Prices are for ungraded cards; a graded one can be worth much more, so set its
value yourself.

A card's page shows today's price, with **Update its value** when it has changed. A collection's **Update values**
lists every card whose price has moved and updates them in one go. Prices only change when you tap that; Ferret
never changes a value on its own.

## LEGO, coins and comics

**+ Add → LEGO sets**, **Coins**, **Comics**, **Movies & TV**, **Video games** and **Records & CDs** look things up in a collector catalog. Each is there when whoever runs
your Ferret has added that catalog's [key](../hosting/server-admin#collector-catalogs). Switch between them at the top,
then:

- **Photograph one**: a LEGO box or its instructions with the set number showing, a coin, a comic's cover, or a
  film's, show's or game's case, or a record's sleeve (its back, with the catalogue number, finds the exact pressing
  best). Ferret
  reads it while you take the next one. **Choose photos** reads several you've already taken. Each photo counts as an
  AI action.
- **Or type it**: a set's number or name (*75192*, *Hogwarts Castle*); a comic's series and issue number (*Amazing
  Spider-Man 300*, *Batman (2016) 50*); for a coin, pick its **country**, add the year if you know it, and type its
  name or face value (*Washington quarter*, *2 euro*); a film's or show's title, with its year or a season if you like
  (*Dune 1984*, *Breaking Bad season 2*); a game's title (*Mario Kart 8 Deluxe*); a record's barcode, or its artist and title (*Nirvana Nevermind*). Then
  tap the right one.

LEGO sets come from [Rebrickable](https://rebrickable.com) with their picture, theme and piece count; coins from
[Numista](https://en.numista.com); comics from [Comic Vine](https://comicvine.gamespot.com) with their cover, publisher
and cover date; films and shows from [TMDB](https://www.themoviedb.org) with their poster, year, studio or network
and genres; video games from [IGDB](https://www.igdb.com) with their cover, year, publisher and platforms; records, CDs and tapes
from [Discogs](https://www.discogs.com): the exact pressing, with its label, catalogue number, country and format.
Each one links back to its page there (**On Rebrickable**, **On Numista**, **On Comic Vine**, **On TMDB**, **On IGDB**,
**On Discogs**), where the catalog has more. Check the list:

- **Not this one?** shows the other matches (another printing of a comic, a set with the same name).
- For a coin, choose its **year and mint** and its **grade** (Good to Uncirculated). Numista's estimate for that year
  and grade shows beside it, in your household's currency.
- For a film or show, choose the **format** you have (DVD, Blu-ray, 4K Ultra HD…) and, for a show, a **season** or the
  whole series. A photo of the case fills these in when it shows them.
- For a game, choose the **platform** your copy is for (Nintendo Switch, PlayStation 5…). A photo of the case picks it
  when its banner shows.
- For a record, choose its **condition** (Mint to Poor, the grading collectors use). Discogs' suggested price for that
  condition shows beside it, or, without one, the lowest price a copy is for sale at now.
- **+ / −** sets how many. The same set or comic again adds to its count.

Choose a **collection**, category and place, then **Save**. Each becomes a thing with the catalog's details, and its
link. If your household has the starter **LEGO set**, **Coin** or **Comic book** [template](collections), its fields
(set number, theme, pieces; year, mint mark, country, grade; series, issue, publisher) are filled in too. A set's,
comic's, film's or game's picture becomes its photo (a show's season gets that season's poster). Numista's coin pictures are its members' own photos, so they're shown but not
copied: photograph your own coin. A coin's estimate or a record's price becomes its value unless you untick it.

A coin's or record's page shows today's price, with **Update its value** when it has changed, and a collection's
**Update values** updates every coin, record (and trading card) whose price has moved, in one go. Values only change when you tap that.

This product uses the TMDB API but is not endorsed or certified by TMDB.

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
