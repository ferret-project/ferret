# Plan and usage

**Settings → Usage** shows what your household has used this month: AI actions, online barcode lookups (where the server
has them),
things, photos and files, and people — and who used what.

On a Ferret you run yourself, nothing is limited: the numbers are just there so you can see where your AI goes.
If your household is on a plan (a hosted Ferret), the same page shows the plan, its limits and how close you are, and
the household's owner gets **Upgrade** and **Manage billing** buttons. Anything about the plan itself — a trial's end, a
cancelled plan's last day — shows under its name.

[Open Usage](/../#/settings/plan){target="_self"}

## AI actions

AI work is counted in *AI actions*, roughly by what it costs to run:

| What | AI actions |
|---|---|
| Suggestions from a photo | 2 |
| A question to Ask Ferret | 1 |
| A document read (receipt, manual, warranty) | 1 |

Searching never uses AI actions (search by meaning comes with a plan that includes AI). A question Ask Ferret can't
find anything for isn't counted, since the model is never asked.

## When a plan's limit is reached

Nothing is deleted or locked. You can still see, edit, search, export and delete everything; only the thing over the
limit stops:

- **AI actions used up** — photos are still saved, just without suggestions, and Ask Ferret says when they come back.
  Search keeps working (by words).
- **No AI in the plan** — Ask Ferret isn't offered, and search finds things by their words.
- **Things, files or people full** — adding stops until you remove some or upgrade. An import adds what fits and lists
  the rest as skipped.
- **Files after a plan ends** — a server that sells plans may, after a warning and a while, keep only small copies of
  the oldest photos over the plan's storage. Under the plan's name it says what will happen and when; until then,
  Download everything has every original.
- **Barcode lookups used up** — Ferret still recognises barcodes it already knows; it just stops asking the online
  database.
- **API keys, share links or calendar feeds not in the plan** — the plan's card lists which it has. Without one, you
  can't make new ones, and those made before are **paused**, not deleted: Claude and your scripts get "not part of the
  … plan", a shared link tells whoever opens it that it's paused, and calendars stop updating. They all work again
  once the household's plan has them.
