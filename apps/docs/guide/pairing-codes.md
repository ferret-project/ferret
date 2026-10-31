# HomeKit and Matter codes

Smart-home devices pair with a setup code — on a sticker on the device, its box or its manual, often as a QR code. You
need it again whenever the device is reset or moved to a new home hub, and by then the box is long gone. Ferret keeps
them with the item.

## Saving a code

On the item's page, **Add HomeKit or Matter code**, then either:

- tap the **QR** button and scan the sticker, or
- paste the code (`X-HM://…` for HomeKit, `MT:…` for Matter), or type it as printed — **123-45-678** (HomeKit) or
  **3497-011-2332** (Matter; Ferret checks its last digit, so a typo is caught).

Ferret shows what it read before you save — *HomeKit · Door lock · 822-04-003*. A note helps when one item has several
(a bridge and its accessories).

You can also just scan the QR from the scanner on the home screen: if the code is already saved, its item opens; if not,
Ferret asks which item it's for.

## Using a code

**Show** displays the code and, when it was saved from its QR, **the QR code itself**. In the Home app, choose **Add
Accessory** and point the camera at the screen — or type the code. **Copy code** copies it without dashes.

## Keeping them safe

A setup code lets anyone on your network pair with that accessory once it's reset, so Ferret treats it as a secret:

- it's stored encrypted, and listed without the code — **Show** fetches it, and the item's history records who looked;
- people with the **viewer** role see that an item has a code, not the code;
- API keys (scripts, Claude) can't read codes;
- pairing QR codes are never sent to the online barcode database.

[Download everything](./download-everything) includes them — another reason to keep that file safe.
