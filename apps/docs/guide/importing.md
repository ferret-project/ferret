# Importing

Got a list already? **Import** in the menu brings things in from a spreadsheet or from Home Assistant. Nothing
is saved until you say so, and a whole import can be undone.

## A spreadsheet (CSV)

Any list with a header row, saved as CSV — from Numbers, Excel or Google Sheets (File → Export / Download → CSV).

1. **Choose a CSV file.** It's read on your device; only the rows you tick are sent.
2. **Check the columns.** Ferret guesses which column is which — name, brand, model, serial number, price, purchase
   date, where it is, category, tags… Change any guess that's wrong, or leave a column out. Several columns can go into
   the notes (each as *"Column: value"*).
3. **Tick what to import.** Every row is ticked to start with, except ones that can't be (no name). Rows with something
   Ferret couldn't read — a date like *"someday"* — say so, and come in without it. **Leave out under $** drops cheap
   things in one go.
4. **Import.**

**Where it is** can be a room (*Kitchen*) or a path (*Garage › Shelf 2*, *Garage / Shelf 2*). Places you already have
are used; missing ones are made, in the property you choose. Categories work the same way (*Electronics › TV*).

A row whose serial number is already on something in Ferret is skipped, so importing the same file twice doesn't make
everything twice.

### Files Ferret recognises

- **Ferret's own export** ([insurance report](./insurance-report) CSV, or `items.csv` from
  [Download everything](./download-everything)) — moving to another server, or another household.
- **Another inventory app's export**: most can save their list as CSV, and its columns are mapped like any other —
  a *sold on* / *sold for* column brings sold things in as [past things](./past-things), and a *warranty expires*
  column becomes a warranty.
- **Amazon order history**: Amazon → Account → *Request your data* → *Your orders*, then use
  `Retail.OrderHistory.1.csv` from the download. Each line becomes a thing with the price you paid, the order date, the
  order number in its notes and a link to the product. Cancelled and returned orders start unticked — and since an
  order history is mostly batteries and phone cases, **Leave out under $** is your friend.

## Home Assistant

If you run [Home Assistant](https://www.home-assistant.io/), it already knows your house — floors and rooms — and your
appliances, TVs, speakers, thermostats, cameras and network gear, with their maker, model, serial number and room.

1. In Home Assistant: your profile → **Security** → **Long-lived access tokens** → **Create token**. It needs to be an
   administrator's.
2. In Ferret: **Import** → **Home Assistant**, its address (*http://homeassistant.local:8123*) and the token, then
   **Read devices**. Ferret reads once and doesn't keep the token — you can delete it in Home Assistant afterwards.
   (Only the household's owner and admins can do this.)
3. **Rooms**: every Home Assistant area can become a place, with things in it or not — under its floor
   (*Main › Kitchen*) unless you turn that off. A room with the same name as a place you have goes there; or pick
   another place, or leave it out (areas called *ignore* or *Other* start left out). If you don't have a home in
   Ferret yet, name it and Ferret makes it.
4. **A floor of its own**: a floor that's really another building — a workshop, a cabin — can be **its own property**:
   pick that beside the floor's name, and its rooms go in a new property named after it.
5. **Devices**: Home Assistant often lists one thing twice (a Sonos through its own integration and through HomeKit);
   Ferret folds those together. Software, services and integrations are tucked under *Probably not things*. Untick
   anything you don't want, then **Import**.

### Importing again later

Run it again whenever Home Assistant has changed — Ferret remembers which room and device each place and thing came
from:

- **New rooms and devices** are offered, ticked; ones already in Ferret say **In Ferret** (or *In Ferret: Main ›
  Kitchen* for a room) and are left alone.
- **Changed in Home Assistant since the last import** lists what HA changed — a device renamed, a new serial number,
  moved to another room — with what Ferret has now crossed out. Ticked changes are made in Ferret; untick any you'd
  rather keep (you renamed it in Ferret on purpose), and it isn't offered again. Only what changed *in Home Assistant*
  is offered, so your own edits in Ferret don't keep coming back.
- **No longer in Home Assistant** lists things whose device has gone from it. Nothing happens to them by itself —
  open one and use *Edit → No longer have it?* if it's really gone.

## Undoing an import

**Import** → **Recent imports** → **Undo…** moves everything that import added to
[Recently deleted](./recently-deleted) (30 days to bring any back). Places and categories it made stay.
