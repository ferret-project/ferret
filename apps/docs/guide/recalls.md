# Recalls

Ferret can check your things against product recalls — the US Consumer Product Safety Commission's list — every day,
and tell you when something you own may be recalled. (Whoever runs your Ferret switches it on; see
[the server admin](../hosting/server-admin#recall-checks).)

## How it matches

It looks at each thing's **brand**, **model** and **barcode**, so the more of those you've filled in (a photo of the
label does it), the better it works:

- **Recalled** — the barcode is on the recall, or the brand and model number are. That's the same product: the recall
  is shown in red, at the top of the dashboard, on the thing's page, and in the bell and the daily reminder.
- **Possibly recalled — check the model** — the same maker and the same kind of thing (a DeWalt drill, a DeWalt drill
  recall), but no model number to be sure. Look at the recall notice and compare the model on the label.

## What to do

On the thing's page, the recall says what the hazard is and what to do (usually: stop using it, contact the maker for
a repair, replacement or refund), with a link to the full notice. Then:

- **Not mine** — a different model, or it doesn't apply: it goes away and isn't offered again.
- **Dealt with it** — repaired, replaced or refunded: it goes away.

Either way the thing's [history](./finding-things#a-thing-s-history) keeps it.

## Food and medicine

The FDA's food and medicine recalls are checked too, by **barcode**: a can, a box of cereal or a bottle of tablets you
scanned in (or [counted as stock](./stock)) is flagged when a recall names its barcode. It's barcode only, since a
maker's name and "cheese" would match far too much.

A barcode match means the product is recalled, not necessarily the one in your cupboard: the recall says which lots or
best-by dates are affected. Compare them with the package before you throw it out. Then **Not mine** or **Dealt with
it**, as above.

## Vehicles

The CPSC doesn't cover cars, trucks or motorcycles, so vehicles are checked against the US National Highway Traffic
Safety Administration's recalls instead (when whoever runs your Ferret has switched on
[vehicle look-ups](../hosting/server-admin#vehicle-look-ups)).

Give the vehicle its **VIN** — the **VIN** field of the **Vehicles** category, or its serial number (Ferret only reads
a serial number as a VIN when it's unmistakably one). Ferret then reads the VIN with NHTSA's decoder, and the thing's
page shows **From the VIN**: its year, make, model and trim (*2003 Honda Accord EX-V6*), the body and engine, and
**Apply** beside the name, brand and model — nothing changes until you tap. A VIN NHTSA can't read says so: check it
for a typo.

Each make, model and year is then checked against NHTSA's recalls (at most once a week), and every recall for it shows
as **Recalled**, like any other, with NHTSA's notice and campaign number. A recall for a model year usually covers only
some of those vehicles: the notice says how to check yours (NHTSA's VIN look-up at nhtsa.gov/recalls, or the maker).

### Fuel economy

When [fuel economy look-ups](../hosting/server-admin#fuel-economy) are on too, a vehicle with a decoded VIN gets a
**Fuel economy** card. The first time, it lists the US EPA's entries for its year, make and model
([fueleconomy.gov](https://www.fueleconomy.gov)): one for each engine and transmission, with those that have the
VIN's engine first (**Same engine as the VIN**). Tap **This one**, or **None of these** if none fits. **Not this one?**
on the card lets you choose again.

The card then shows its miles per gallon (combined, city and highway; an electric car's MPGe, kWh per 100 miles and
range) and **about what a year's fuel costs**: 15,000 miles a year, 55% of them in town (the EPA's own assumptions),
at this week's average price of its fuel in its state, or its region where the US Energy Information Administration
doesn't price the state on its own (an electric car at its state's average home electricity rate). The state comes
from its property's address, else your household's only state. When the server has no EIA key, the cost is the EPA's
own estimate at US average prices. A home outside the US gets the figures but no cost.
