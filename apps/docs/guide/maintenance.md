# Maintenance

**Maintenance** keeps the jobs that come round again: *replace the furnace filter every 3 months*, *service the
mower every spring*, *clean the dryer vent every year*. A task can be on an item, on a place, or on the whole household,
and can repeat or be a one-off.

## Doing a task

![Maintenance: what's due in the next two weeks and what's coming up, each with Done](/screenshots/maintenance-light.webp){.shot .light-only}
![Maintenance: what's due in the next two weeks and what's coming up, each with Done](/screenshots/maintenance-dark.webp){.shot .dark-only}

Tap **Done** when it's done: say when, who did it and what it cost. The next due date moves on from the day it was
actually done — so a job done late doesn't come due again too soon. A one-off is finished once it's done.

Each task keeps its history, and the item's page shows its maintenance.

## By use {#by-use}

Some upkeep goes by how much something's used, not the calendar: *change the oil every 5,000 miles*, *service the
mower every 50 hours*, *descale every 300 cycles*.

1. On the thing's page, **Track miles / hours** — say what it counts (miles, km, hours or cycles) and what it says now.
2. In its maintenance task, turn on **By use** and say how much — or **Also by use** for a task that repeats by time
   too: whichever comes first (*every 5,000 miles or 6 months*).
3. Now and then, **log a reading** on its page (or ask Claude: *"the car's at 42,180 miles"*).

From two readings at least a week apart Ferret works out how fast it's used and estimates the date — the list says
**Due around** — and that date is what reminders and the calendar use. A reading past the mark makes it due from that
day. Until there's a rate it checks in a year after the last reading. **Done** asks what it says now; the next one is
due that much further on.

## Parts it uses

A task can use up something you keep in stock — *Replace furnace filter* uses one *Furnace filter 20×25×1*. Set it in
the task under **Uses a part**, with how many each time. Then:

- **Done** takes them out of stock (untick **Took … from stock** if you cleaned the old one instead);
- the list shows how many are left;
- if there aren't enough for the next time, the task shows up in the bell **a month ahead** instead of a week —
  *Due in 12 days — no Furnace filter left* — and the part goes on the [shopping list](./stock#shopping-list), so
  there's time to order.

## From a manual

Upload a product's manual as a document and Ferret may suggest the maintenance it recommends. Nothing is added until
you tap it.

## Service providers

**Service providers** (in the menu) are the people who work on your home — a plumber, the HVAC company, an appliance
repair shop — with their phone, email and website. A task can say who usually does it, and each time it's done can
say who did it and what it cost, so you can see what you spend with whom.

## Reminders

Due and overdue tasks remind you — see [Reminders](./reminders).
