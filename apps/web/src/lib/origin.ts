import { t as translateText } from "./../i18n";
/** Where things came from (`item.origin`), in words: on an item's page, and for the Everything list's filter. */
import type { ItemOrigin } from "@ferret/shared";

/** "Added …, <how>". */
export const ORIGIN_HOW: Record<ItemOrigin, string> = {
  get app() { return translateText("in the app"); },
  get photos() { return translateText("with Add from photos"); },
  get walkthrough() { return translateText("on a room walkthrough"); },
  get roomscan() { return translateText("from a room scan"); },
  get scan() { return translateText("by scanning its barcode"); },
  get label() { return translateText("from a QR label"); },
  get spreadsheet() { return translateText("from a spreadsheet"); },
  get homeassistant() { return translateText("from Home Assistant"); },
  get claude() { return translateText("by Claude"); },
  get api() { return translateText("by a script (API key)"); },
};

/** The filter's choices: "Added by Claude". */
export const ORIGIN_FILTER: Record<ItemOrigin, string> = {
  get app() { return translateText("Typed into the app"); },
  get photos() { return translateText("Added from photos"); },
  get walkthrough() { return translateText("Added on a walkthrough"); },
  get roomscan() { return translateText("Found in a room scan"); },
  get scan() { return translateText("Added by scanning"); },
  get label() { return translateText("Added from a QR label"); },
  get spreadsheet() { return translateText("Imported from a spreadsheet"); },
  get homeassistant() { return translateText("Imported from Home Assistant"); },
  get claude() { return translateText("Added by Claude"); },
  get api() { return translateText("Added by a script"); },
};

export const itemOriginList = Object.keys(ORIGIN_FILTER) as ItemOrigin[];
