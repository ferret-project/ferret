# The server admin

Some things belong to the whole server rather than one household — backups, recall checks and the service error log. One person looks after them: the
**server admin**. They see **Settings → Server** and get backup alerts in the bell; nobody else does.

It's the **first account** made on the server, until it's handed over:

- In **Settings → Server → Server admin**: enter the email of another account (it must have confirmed its email), and
  confirm. You lose the tab once it's theirs.
- On the server, for when the admin's account is gone or locked out:

  ```bash
  docker compose exec ferret node dist/cli.js admin                    # who it is
  docker compose exec ferret node dist/cli.js admin someone@example.com
  ```

If the admin's account is deleted, it falls back to the oldest account. Server settings never work with an API key.

## Recall checks

**Settings → Server → Recall checks** switches on checking everyone's things against the US Consumer Product Safety
Commission's recalls ([what people see](../guide/recalls)). It's off until you switch it on, because it sends the
**brands** people own (nothing else — not names, models or anything about them) to the CPSC's public recall search at
saferproducts.gov, each brand at most once a week. The answers are kept on the server and every household is checked
against them daily. Switching it off stops the asking; recalls already found stay on the things they were found for.

## Vehicle look-ups

**Settings → Server → Vehicle look-ups** switches on reading vehicles' VINs with the US National Highway Traffic Safety
Administration's decoder, and checking vehicles against NHTSA's recalls ([what people see](../guide/recalls#vehicles)).
It's off until you switch it on, because it sends each **VIN** to NHTSA's decoder (vpic.nhtsa.dot.gov), and each
vehicle's **make, model and year** to its recall search (api.nhtsa.gov) at most once a week — nothing else. Switching
it on reads the VINs already in Ferret straight away.

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
sent to Open Library — nothing else — once for the whole server.

## Trading cards

**Settings → Server → Trading cards** adds **Scan cards** to everyone's **+ Add**
([what people see](../guide/adding-things#trading-cards)). Pokémon cards are looked up on [TCGdex](https://tcgdex.dev)
and Magic: The Gathering cards on [Scryfall](https://scryfall.com), with their pictures and market prices. Both are free,
need no key and have no allowance. It's off until you switch it on, because what's printed on a card (its name, number
and set) is sent to them. Prices are kept a day for the whole server. Reading a photo of a card uses your vision model
(`VISION_URL`) and counts as an AI action. Without a vision model, people type the cards instead.

## Collector catalogs

**Settings → Server → Collector catalogs** adds **LEGO sets**, **Coins** and **Comics** to everyone's **+ Add**
([what people see](../guide/adding-things#lego-coins-and-comics)). Each catalog needs a free key from an account there.
Paste it in and Ferret checks it with the catalog before saving it. That catalog is on from then, and **Remove** turns
it off again.

| Catalog | For | Where to get a key | Allowance |
| --- | --- | --- | --- |
| [Rebrickable](https://rebrickable.com) | LEGO sets | Sign in, then your profile's **Settings → API** ([about the API](https://rebrickable.com/api/)) | A request a second or so |
| [Numista](https://en.numista.com) | Coins, with estimates by grade | Sign in, then [numista.com/api](https://en.numista.com/api/) | 2,000 requests a month on the free plan |
| [Comic Vine](https://comicvine.gamespot.com) | Comics | Sign in, then [comicvine.gamespot.com/api](https://comicvine.gamespot.com/api/) | 200 requests an hour |

Only the words people search for (and what was read off a photo) are sent, never anything else about them or what they
own. What a catalog says is kept for the whole server, so its allowance goes far: a coin's details for a month and its
estimates for a week, sets and comics for three months. Keys are stored sealed with a key made from `FILES_KEY`, so
backups keep them and Settings only ever shows their last four characters. Reading a photo uses your vision model
(`VISION_URL`) and counts as an AI action. Without a vision model, people type instead.

Each catalog has its own terms for its API: read them when you get the key (Comic Vine's, for one, is for non-commercial use).

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
docker compose exec ferret node dist/cli.js key fingerprint          # which FILES_KEY is in use
docker compose run --rm ferret node dist/cli.js backup list          # and backup check / restore
```

[Certificates](./certificates) and [Backups](./backups) say more about theirs.
