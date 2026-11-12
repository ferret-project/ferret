# Finding things

## Search

![Searching for drill: three matches, one found by the words on its label photo](/screenshots/search-light.webp){.shot .light-only}
![Searching for drill: three matches, one found by the words on its label photo](/screenshots/search-dark.webp){.shot .dark-only}

The search box finds things by any word in them — name, brand, model, serial number, notes, tags, place — and by the
text **inside their photos and documents** (a receipt, a label, a manual). Part of a serial number is enough.

If whoever runs Ferret has turned on smart search, it also finds things by **meaning**: *"something to make holes"*
finds the drill.

Searching from a room, a category or a tag looks only in there — **Search everywhere** under the box widens it.

### Getting around quickly

| | |
|---|---|
| <kbd>/</kbd> or <kbd>⌘</kbd> <kbd>K</kbd> (<kbd>Ctrl</kbd> <kbd>K</kbd>) | Jump to the search box, from anywhere in Ferret (on a thing's page: search inside it) |
| <kbd>Esc</kbd> | Clear the search (again: leave the box) — or tap the **✕** |
| <kbd>↓</kbd> / <kbd>↑</kbd> | Move through the results; <kbd>Enter</kbd> opens one, <kbd>Esc</kbd> goes back to the box |
| <kbd>Enter</kbd> in the box | Search now, and go to the results |

A search stays in the page's address, so **Back** from a thing returns to your results, and a search can be
bookmarked or shared with the household. Tapping the empty box shows your **recent searches** on that device.

## A thing's history

At the bottom of every item's page, **History** lists what happened to it, newest first: when it was added, each edit
in words (*Moved Drill: Garage → Basement*, *value $80.00 → $95.00*), photos and documents, warranties and claims,
maintenance done, and stock used or bought — with who did it, and whether through Claude or the API. **Show all**
opens the rest. It stays for things you no longer have, too. Claude can read it as well: *"when did we move the
ladder?"*

## Last scanned

Each time someone scans a thing's [QR label](./labels), barcode or pairing code — with the phone's camera or Ferret's
scanner — Ferret notes when, and who. Its page says so under *Added…* (*Label last scanned 3 days ago by Sam*), a box
lists it beside each thing inside, and **Everything → Last scanned** finds what nobody has scanned in a month, six
months or a year (never scanned counts). A scan only means someone looked the code up; it isn't kept in the history,
and it doesn't count as a change to the thing. When a code is on several things, only the one picked counts.

## Ask Ferret

Ask a question in plain words — *"when does the dishwasher warranty end?"*, *"where's the camping stove?"* — and
Ferret answers from your inventory and its documents, with the items it used. (Needs the AI features; see
[AI features](../hosting/ai).)

## Searching one thing

On a thing's page, the search at the top (or <kbd>/</kbd>, <kbd>⌘K</kbd>) searches **inside that thing** rather than
everything: its documents (a manual answers with the section it's in: *"8.2 Cleaning and bag inspection"*), the text
read from its photos, its warranties, and its description and notes. The words are highlighted; tap a passage to read
all of it, or open the document.

**Ask about this item** answers a question from that thing alone — *"how do I reset it when it shuts off?"*, *"what
doesn't the protection plan cover?"* — and shows the documents it used. It counts as an AI action, like Ask Ferret.
**Search everything** takes your words to the home screen's search.

## Browsing

- **Home** shows what your things are worth — over time (a running total by when things were bought, or added if
  there's no date: what you have now, so things you've sold or lost don't count) and by category — what's missing for a
  claim, warranties ending soon and recent changes.
- **Everything** lists every item, 50 to a page (see below).
- **Places** goes property by property, room by room.
- A category or tag page lists what's in it.

## Everything

**Filter** by where things came from, what they're missing, category, place, tag or when they were last scanned, and
choose the **order** — last changed, newest, name, most valuable, bought most recently or scanned most recently. On a
phone these are under **Filter and sort**. Or [describe it in plain words](./ai#describe-what-you-re-looking-for):
*tools bought last year over $100*.

On a computer or tablet, Everything is a **table** (switch to **List** at the top right if you'd rather). Click a column
heading — Name, Value, Bought — to sort by it; click again to reverse. Click a row to see the thing **at a glance** beside
the table (its photo and details) without leaving the list; its name opens its page.

### Changing many things at once

Tick the things in the table (the box in the heading ticks the whole page), then:

- **Move** — to another place. Things in a box come out of it; a box takes its contents along.
- **Category** — give them all one category.
- **Tag** / **Remove tag**.
- **Delete** — they go to Recently deleted, where they can be brought back for 30 days.

Each thing's history records the change. Viewers see the table without the tick boxes.
