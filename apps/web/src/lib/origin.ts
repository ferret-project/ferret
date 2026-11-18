/** Where things came from (`item.origin`), in words: on an item's page, and for the Everything list's filter. */
import type { ItemOrigin } from "@ferret/shared";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";

/** "Added …, <how>". */
export const ORIGIN_HOW: Record<ItemOrigin, MessageDescriptor> = {
  app: msg`in the app`,
  photos: msg`with Add from photos`,
  walkthrough: msg`on a room walkthrough`,
  roomscan: msg`from a room scan`,
  scan: msg`by scanning its barcode`,
  label: msg`from a QR label`,
  receipt: msg`from a receipt with several things on it`,
  words: msg`by describing it in words`,
  spreadsheet: msg`from a spreadsheet`,
  homeassistant: msg`from Home Assistant`,
  paperless: msg`from a Paperless document`,
  claude: msg`by Claude`,
  api: msg`by a script (API key)`,
};

/** The filter's choices: "Added by Claude". */
export const ORIGIN_FILTER: Record<ItemOrigin, MessageDescriptor> = {
  app: msg`Typed into the app`,
  photos: msg`Added from photos`,
  walkthrough: msg`Added on a walkthrough`,
  roomscan: msg`Found in a room scan`,
  scan: msg`Added by scanning`,
  label: msg`Added from a QR label`,
  receipt: msg`Added from a receipt`,
  words: msg`Described in words`,
  spreadsheet: msg`Imported from a spreadsheet`,
  homeassistant: msg`Imported from Home Assistant`,
  paperless: msg`Added from Paperless`,
  claude: msg`Added by Claude`,
  api: msg`Added by a script`,
};

export const itemOriginList = Object.keys(ORIGIN_FILTER) as ItemOrigin[];
