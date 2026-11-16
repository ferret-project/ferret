# Paperless-ngx

If you keep your paperwork in [Paperless-ngx](https://docs.paperless-ngx.com), Ferret can take the receipts and manuals
that belong to your things from it. Tag a document in Paperless and it comes to Ferret's **From Paperless** inbox. From
there you add it as a new thing, or put it on one you already have.

Ferret only ever **reads** Paperless. It never changes, tags or deletes anything there.

## Connecting

The household's owner or an admin does this once, in **Settings → Household → Paperless-ngx → Connect…**:

1. **In Paperless**, make the tag Ferret will watch, for example `ferret`. A good way to fill it: a consume subfolder
   that tags what's dropped in it, or a mail rule that tags receipts from your favourite shops.
2. **An API token**: in Paperless, your name → **My profile** → **API auth token**. A Paperless user that can only
   *view* documents is enough, and is the safest choice. Make one just for Ferret.
3. **In Ferret**, enter Paperless's address (the one Ferret's server reaches it at), the token and the tag.
   **Copy files into Ferret** is on to start with (see [Copy or link](#copy-or-link)).

Ferret checks the token and the tag before saving, so a mistake shows up straight away. The token is kept encrypted
with your household's key and never shown again. To change it, use **Change…** and paste a new one.

Paperless on your own network (`https://paperless.example.lan`, `http://10.0.0.5:8000`) can only be connected by the
[server admin](../hosting/server-admin): someone else's household can't point Ferret's server at your network. If
Paperless has a certificate from your own certificate authority, the server admin trusts it in **Settings → Server →
[Certificates](../hosting/certificates)**.

## The inbox

**From Paperless** (in **Add things**, on the Import screen, and in the bell when something's waiting) lists the
tagged documents nobody has sorted yet, newest first, with Paperless's picture of each and its first words.

- **New thing…** makes a thing named after the document (change the name, pick where it's kept), with the document on
  it.
- **Put on a thing…** puts it on one you have. When the document's title matches a thing, Ferret offers that one first.
- **Dismiss** takes it out of the inbox (tax letters, anything that isn't about a thing). **Sorted** lists what was
  done with each document, and a dismissed one can go back to the inbox.

Ferret looks for new documents every ten minutes, and right away with **Check now**. Sorting is remembered in Ferret,
so a document keeps its tag in Paperless and doesn't come back. Members can sort the inbox; viewers can only look.

## From a thing's page

**Attach from Paperless** (under the thing's photos and documents) searches all of Paperless, whatever the tags, and
attaches the document you pick.

## Copy or link

- **Copied** (the default): Ferret keeps its own copy, Paperless's archived PDF when it made one, or the picture. It's
  read like any upload, so the price, date, model and serial number are offered as
  [suggestions](./ai), and it's in Ferret's backups and **Download everything**. The thing also gets a link back to the
  document in Paperless.
- **Linked only**: the thing just gets the link. Nothing is copied or read.

Documents that are only text in Paperless (a `.txt` file, an email body) are always linked.

## When it stops working

**Settings → Household** shows when Ferret last checked and the last error, for example *"Paperless refused the
token"* or *"its certificate isn't trusted"*. After a day of failing, the bell says so too. **Disconnect…** drops the
token and the inbox. Files already copied stay on their things.
