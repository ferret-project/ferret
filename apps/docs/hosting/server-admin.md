# The server admin

Some things belong to the whole server rather than one household — backups, recall checks and the service error log. One person looks after them: the
**server admin**. They see **Settings → Server** and get backup alerts in the bell; nobody else does.

**Settings → Server** has four parts along its top:

- **Status** — backups, the [server check](./server-check) and disk space, updates, and the service error log. Links
  from the bell and Ferret's alert emails open this one.
- **AI** — search by meaning, Ask Ferret's limits, what AI fills in by itself, and the AI's prompts.
- **Lookups** — the outside databases Ferret can ask, in three groups: products and prices (barcodes, groceries, eBay,
  exchange rates, ENERGY STAR), safety and upkeep (recalls, vehicles, repair guides, device support) and collections
  (books, music, cards, collector catalogs, grading, Bike Index).
- **Access** — the server's [keys](./backups#a-key-file-for-files-key), handing over the server admin, and
  [certificates](./certificates).

It's the **first account** made on the server, until it's handed over:

- In **Settings → Server → Access → Server admin**: enter the email of another account (it must have confirmed its email), and
  confirm. You lose the tab once it's theirs.
- On the server, for when the admin's account is gone or locked out:

  ```bash
  docker compose exec ferret node dist/cli.js admin                    # who it is
  docker compose exec ferret node dist/cli.js admin someone@example.com
  ```

If the admin's account is deleted, it falls back to the oldest account. Server settings never work with an API key.

## Updates

**Settings → Server → Updates** tells you when a new version of Ferret is out. It's off until you switch it on, because
it asks GitHub for Ferret's newest release once a day: GitHub sees your server's address, and nothing else is sent.
When there's a newer release than the one running, the bell says so, and the card shows what's new and a link to the
release. Updating is still yours to do: pull the new image and start it again (`docker compose pull`, then
`docker compose up -d`), or update it from Unraid's, TrueNAS's or your app store's own screens. A build between
releases can't be compared, so the card only names the newest release.

The card also isn't shown on a Ferret someone else runs for you.

## Disk space

The **Server check** card shows how much space is free on each disk Ferret writes to: the database's, the photos and
documents', and the backups' (`BACKUP_DIR`), one line for those that share a disk. When one has less than 10% free
(at least 1 GB, at most 10 GB), it turns red, the server check lists it, and the bell tells you (urgently below half of
that). A full disk stops uploads, the database and backups, so free some space or move the data to a bigger disk
before it fills.

## Recall checks

**Settings → Server → Recall checks** switches on checking everyone's things against the US Consumer Product Safety
Commission's recalls ([what people see](../guide/recalls)). It's off until you switch it on, because it sends the
**brands** people own (nothing else — not names, models or anything about them) to the CPSC's public recall search at
saferproducts.gov, each brand at most once a week. The answers are kept on the server and every household is checked
against them daily. Switching it off stops the asking; recalls already found stay on the things they were found for.

Recall checks also cover the **FDA's food and medicine recalls**, from [openFDA](https://open.fda.gov): once a day the
server fetches the last two years' recall reports (no key; nothing about anyone's things is sent) and keeps those
that name a barcode, which are then matched against things' barcodes. (The USDA's meat and poultry recalls aren't
included: their site turns away software, and those recalls rarely carry a barcode.)

## Vehicle look-ups

**Settings → Server → Vehicle look-ups** switches on reading vehicles' VINs with the US National Highway Traffic Safety
Administration's decoder, and checking vehicles against NHTSA's recalls ([what people see](../guide/recalls#vehicles)).
It's off until you switch it on, because it sends each **VIN** to NHTSA's decoder (vpic.nhtsa.dot.gov), and each
vehicle's **make, model and year** to its recall search (api.nhtsa.gov) at most once a week — nothing else. Switching
it on reads the VINs already in Ferret straight away.

### Fuel economy

Once vehicle look-ups are on, the same card has a second switch, **Fuel economy**: a vehicle's EPA miles per gallon
and what a year's fuel costs ([what people see](../guide/recalls#fuel-economy)), from
[fueleconomy.gov](https://www.fueleconomy.gov) (free, no key). It's off until you switch it on, because a decoded
vehicle's **make, model and year** are sent — nothing else. The entries for a make, model and year are kept for the
whole server for 90 days.

With the EIA key from [ENERGY STAR look-ups](#energy-star-look-ups), fuel is priced at the EIA's weekly average for
the vehicle's state or region (regular, midgrade or premium gasoline, or diesel), fetched once a week for the whole
server. Without it, the cost is the EPA's estimate at US average prices.

## Exchange rates

**Settings → Server → Exchange rates** shows prices that come in another currency in each household's own. UPCitemdb's
typical prices are US dollars from US stores, and card prices are dollars (TCGplayer) or euros (Cardmarket). Converted
prices are marked ≈ with the original beside them (*≈ 40,58 zł ($9.99)*), and they can be used as a thing's value.
The rates are the European Central Bank's, fetched once a day from [Frankfurter](https://frankfurter.dev); nothing
about anyone is sent. It's off until you switch it on. Without it, such prices show in their own currency and aren't
offered as a value in another one, and a household in a currency other than dollars or euros gets no card prices.

## Device support

**Settings → Server → Device support** offers, on the pages of phones, tablets, watches, e-readers and the like,
when their security updates stop ([what people see](../guide/replacements#software-updates)), from
[endoflife.date](https://endoflife.date). Once someone confirms the model, the bell warns them 90 days ahead. Ferret
downloads endoflife.date's public device lists once a day and matches things itself, so nothing about anyone's things
is sent. It's off until you switch it on.

## Groceries and household goods

**Settings → Server → Groceries and household goods** asks [Open Food Facts](https://openfoodfacts.org),
[Open Products Facts](https://world.openproductsfacts.org) and [Open Beauty Facts](https://world.openbeautyfacts.org)
about a barcode the online product database doesn't know, or about every barcode if `BARCODE_LOOKUP` isn't set. That
covers groceries, cleaning supplies, batteries, light bulbs and toiletries. They're open databases, free, with no key
and no allowance, so they aren't counted against any lookup limit and they save UPCitemdb's 100 a day for the rest.
It's off until you switch it on, because the **barcode** is sent to them, once for the whole server.

## Book look-ups

**Settings → Server → Book look-ups** switches on asking [Open Library](https://openlibrary.org) about books' ISBNs
([what people see](../guide/adding-things#books)), instead of the online product database. It's free and has no
allowance, so it isn't counted against any lookup limit. It's off until you switch it on, because a book's **ISBN** is
sent to Open Library — nothing else — once for the whole server. It also adds **Books by title** to + Add, for older
books without a barcode: the words people search for are sent to Open Library's search.

Optionally add a **Google Books** key there too: then every book is asked of
[Google Books](https://books.google.com) as well, and the two answers are merged detail by detail — Google knows many
more recent and non-English books, and usually has a cover and a blurb when Open Library doesn't. Make a Google Cloud
project, [enable the Books API](https://console.cloud.google.com/apis/library/books.googleapis.com) and
[create an API key](https://console.cloud.google.com/apis/credentials) (restrict it to the Books API), then paste it in.
It's checked with Google before it's saved, kept sealed like the collector catalogs' keys, and only the ISBN is sent.

## Trading cards

**Settings → Server → Trading cards** adds **Scan cards** to everyone's **+ Add**
([what people see](../guide/adding-things#trading-cards)). Pokémon cards are looked up on [TCGdex](https://tcgdex.dev)
and Magic: The Gathering cards on [Scryfall](https://scryfall.com), with their pictures and market prices. Both are free,
need no key and have no allowance. It's off until you switch it on, because what's printed on a card (its name, number
and set) is sent to them. Prices are kept a day for the whole server. Reading a photo of a card uses your vision model
(`VISION_URL`) and counts as an AI action. Without a vision model, people type the cards instead.

## Graded coins and cards

**Settings → Server → Graded coins and cards** lets people check a slab's certificate number on a coin's or trading
card's page ([what people see](../guide/collections#graded-coins-and-cards)): with [PCGS](https://www.pcgs.com) for
coins (the grade, how many PCGS has graded the same and higher, and its price guide value, offered as the thing's
value) and with [PSA](https://www.psacard.com) for cards (the grade and population; PSA gives no prices). Each needs a
key: PCGS's API token is free from [pcgs.com/publicapi](https://www.pcgs.com/publicapi). PSA's access token
([psacard.com/publicapi](https://www.psacard.com/publicapi)) is a paid subscription — PSA no longer offers free API
access (its smallest plan was $179 a year for 50 checks a day in November 2026) — and the token works only once PSA
has approved your account.
Only certificate numbers are sent; each answer is kept for the whole server a week.

## Bike Index look-ups

**Settings → Server → Bike Index look-ups** shows, on a bike's page, whether a bike with its serial number is
reported stolen on [Bike Index](https://bikeindex.org), a non-profit bike registry, with links to register it there or
to report it when it's marked stolen ([what people see](../guide/past-things#stolen-bikes)). Free, no key. It's off
until you switch it on, because a bike's **serial number** is sent, and only for things that look like bikes (by their
name or category). Each answer is kept for the whole server for a day. Ferret never signs in to Bike Index for anyone:
registering and reporting happen on their site.

## eBay listings

**Settings → Server → eBay listings** adds **Check eBay** to a thing's page (eBay is asked only when someone taps it),
and an **On eBay now** card beside a listing the AI drafts ([what people see](../guide/past-things#on-ebay-now)): up to five listings for the same thing on eBay and the
range of asking prices, linking to eBay. It finds them by the thing's **barcode**, else its **brand and model number**
(a model with a digit in it) — or, for someone's [own listing](../guide/past-things#your-own-listing), its item number; those are all that's sent, to the eBay of the household's country (worked out like its
Amazon store, eBay US otherwise). They're asking prices: eBay keeps sold prices to a restricted API.

It needs a free keyset from the [eBay Developers Program](https://developer.ebay.com): create a **Production**
keyset, then paste its **App ID** and **Cert ID** with a space between them. In the keyset's **Alerts &
Notifications**, under Marketplace Account Deletion, turn on **Exempted from Marketplace Account Deletion** and give
the reason that you don't persist eBay data (Ferret keeps none); eBay switches off keysets that neither do that nor
receive its notifications. Each self-hosted server uses its own keyset and agrees to eBay's API License Agreement itself.
From the command line: `node dist/cli.js service-keys set ebay`.

eBay's terms set how the listings are kept: answers are kept **in memory for an hour** (never in the database, so not in
backups or exports), the card says when they're from, and nothing from eBay is written to a thing — a value you want
to keep, you type yourself. A keyset allows 5,000 searches a day.

## ENERGY STAR look-ups

**Settings → Server → ENERGY STAR look-ups** shows an appliance's certified energy use on its page: a fridge's, freezer's,
washer's, dryer's, dishwasher's, dehumidifier's, air conditioner's, water heater's, TV's or air cleaner's kWh a year
and how it compares with the US standard, or a furnace's efficiency (AFUE), with a link to its page in ENERGY STAR's
[product finder](https://www.energystar.gov/productfinder/). It comes from the US EPA's
[open data](https://data.energystar.gov): free, no key. It's off until you switch it on, because a thing's **brand and
model number** (or its barcode) are sent. Each answer, a match or none, is kept for the whole server for a month.
Only appliances certified for the US and Canada are listed.

Optionally add a key from the US Energy Information Administration
([register here](https://www.eia.gov/opendata/register.php), free) in the same card: then each card also says what
that energy costs a year at the average home rate in the thing's state (from its property's address, else your
household's only state, else the US average). The prices are fetched once a month for the whole server; nothing about
anyone is sent. Homes outside the US get no cost, since US prices say nothing about them. The same key prices
vehicles' fuel each week ([fuel economy](#fuel-economy)).

## Collector catalogs

**Settings → Server → Collector catalogs** adds **LEGO sets**, **Coins**, **Comics**, **Movies & TV**, **Video games** and **Records & CDs**
to everyone's **+ Add**
([what people see](../guide/adding-things#lego-coins-and-comics)). Each catalog needs a free key from an account there.
Paste it in and Ferret checks it with the catalog before saving it. That catalog is on from then, and **Remove** turns
it off again. Keys can also be saved from [the command line](#the-command-line).

| Catalog | For | Where to get a key | Allowance |
| --- | --- | --- | --- |
| [Rebrickable](https://rebrickable.com) | LEGO sets | Sign in, then your profile's **Settings → API** ([about the API](https://rebrickable.com/api/)) | A request a second or so |
| [Numista](https://en.numista.com) | Coins, with estimates by grade | Sign in, then [numista.com/api](https://en.numista.com/api/) | 2,000 requests a month on the free plan |
| [Comic Vine](https://comicvine.gamespot.com) | Comics | Sign in, then [comicvine.gamespot.com/api](https://comicvine.gamespot.com/api/) | 200 requests an hour |
| [TMDB](https://www.themoviedb.org) | Films and TV shows | Sign in, then **Settings → API** ([themoviedb.org/settings/api](https://www.themoviedb.org/settings/api)): the API key or the read access token both work | About 50 requests a second |
| [IGDB](https://www.igdb.com) | Video games | A Twitch app: sign in at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) (two-step sign-in on), **Register Your Application** (redirect `http://localhost`, type Confidential), then copy its client ID and make a **New Secret**. Paste both, separated by a space | 4 requests a second |
| [Discogs](https://www.discogs.com) | Records, CDs and tapes, with prices | Sign in, then [Settings → Developers](https://www.discogs.com/settings/developers) → **Generate new token**. For prices by condition, also save the account's [seller settings](https://www.discogs.com/settings/seller) once (nothing has to be for sale) | 60 requests a minute |

Only the words people search for (and what was read off a photo) are sent, never anything else about them or what they
own. What a catalog says is kept for the whole server, so its allowance goes far: a coin's details for a month and its
estimates for a week, a record's prices for three days, sets, comics, films, shows, games and records for three
months. Keys are stored sealed with a key made from `FILES_KEY`, so
backups keep them and Settings only ever shows their last four characters. Reading a photo uses your vision model
(`VISION_URL`) and counts as an AI action. Without a vision model, people type instead.

Each catalog has its own terms for its API: read them when you get the key (Comic Vine's, for one, is for non-commercial use).
This product uses the TMDB API but is not endorsed or certified by TMDB.

## Music look-ups

**Settings → Server → Music look-ups** adds **Scan music** to everyone's **+ Add**
([what people see](../guide/adding-things#music)): barcodes scanned there are asked of
[MusicBrainz](https://musicbrainz.org), and covers come from the [Cover Art Archive](https://coverartarchive.org).
It's free, with no key and no allowance, so it isn't counted against any lookup limit. It's off until you switch it
on, because the **barcode** is sent to MusicBrainz — nothing else — once for the whole server. Only barcodes scanned
with Scan music go there; an ordinary scan never does. MusicBrainz answers about one question a second, so Ferret asks
one at a time.

## Repair guides

**Settings → Server → Repair guides** switches on [links to iFixit](../guide/repairs#repair-guides) for things whose
brand and model iFixit knows. It's off until you switch it on, because it sends a thing's **brand and model** (a
vehicle's make, model and year) to iFixit's public search — nothing else — each at most once a month, for every
household together. Ferret only links to iFixit; it never copies its guides.

## Smart search

**Settings → Server → Smart search** (shown when [smart search](ai) is set up) names the embedding model and the
vector store, and how many things are embedded. After a change of model or collection, Ferret embeds everything again
by itself, and this card follows it. **Re-index everything** clears the index and embeds every thing again — for a
change Ferret can't tell from the names ([changing the embedding model](ai#changing-the-embedding-model)).

## Ask Ferret

**Settings → Server → Ask Ferret** sets how much the answering model can read at once — its context size — so Ask
reads as much of a long manual as the model can take. See [Ask Ferret's context size](ai#ask-ferret).

## Service errors

**Settings → Server → Service errors** lists every failed call to a service Ferret uses — the AI models (Ollama, the
chat model, the reranker), the vector store (Qdrant), the document reader (docling), Apprise, Web Push, the barcode and
recall databases, Apple Maps — with how many times and when. When one starts failing you get told (push, your other
apps, and email if Ferret can send it), at most once every 6 hours per service, and it's in the bell for a day. Ferret
carries on without them where it can (search by words only, photos read later). **Clear all** once it's fixed.

Background jobs that gave up after their last try are listed too ("Background jobs"), and Ferret's own unexpected
errors ("Ferret itself").

The email has a **For triage** part, and each error has **Copy details**: what failed, when (in your household's time
zone), how long the call took, where in Ferret it was called from, what the service said — for an AI model, which model,
why its reply stopped and how many tokens it used — and which server and version this is. Paste it into a bug report,
or to Claude. It never includes what people typed or own: a model's reply is cut down to its first and last few words.

## The command line

What's done on the server itself, without a browser. With Docker Compose, in the folder with `compose.yaml`:

```bash
docker compose exec ferret node dist/cli.js admin [email]            # who the server admin is, or hand it over
docker compose exec ferret node dist/cli.js certificates list        # certificates for Ferret's own connections
docker compose exec -T ferret node dist/cli.js certificates trust - "Home CA" < home-ca.pem
docker compose exec ferret node dist/cli.js certificates remove "Home CA"
docker compose exec ferret node dist/cli.js service-keys list        # outside services' keys (last four only)
docker compose exec -it ferret node dist/cli.js service-keys set tmdb  # asks for the key, checks it, saves it
docker compose exec -T ferret node dist/cli.js service-keys set tmdb < tmdb.key
docker compose exec ferret node dist/cli.js key fingerprint          # which FILES_KEY is in use
docker compose run --rm ferret node dist/cli.js backup list          # and backup check / restore
```

[Certificates](./certificates) and [Backups](./backups) say more about theirs. `service-keys` saves the keys
[Collector catalogs](#collector-catalogs), [Google Books](#book-look-ups), the EIA's
[electricity and fuel prices](#energy-star-look-ups) and [graded coins and cards](#graded-coins-and-cards) take —
`rebrickable`, `numista`, `comicvine`, `tmdb`, `igdb`, `discogs`, `google-books`, `eia`, `pcgs`, `psa` — checked
with the service first, as in Settings. A key is typed at the hidden prompt or piped in, never given as an argument,
so it stays out of your shell's history. A running Ferret uses it straight away.
