/** Where things came from (`item.origin`), in words: on an item's page, and for the Everything list's filter. */
import type { ItemOrigin } from "@ferret/shared";

/** "Added …, <how>". */
export const ORIGIN_HOW: Record<ItemOrigin, string> = {
  app: "in the app",
  photos: "with Add from photos",
  walkthrough: "on a room walkthrough",
  roomscan: "from a room scan",
  scan: "by scanning its barcode",
  label: "from a QR label",
  spreadsheet: "from a spreadsheet",
  homeassistant: "from Home Assistant",
  claude: "by Claude",
  api: "by a script (API key)",
};

/** The filter's choices: "Added by Claude". */
export const ORIGIN_FILTER: Record<ItemOrigin, string> = {
  app: "Typed into the app",
  photos: "Added from photos",
  walkthrough: "Added on a walkthrough",
  roomscan: "Found in a room scan",
  scan: "Added by scanning",
  label: "Added from a QR label",
  spreadsheet: "Imported from a spreadsheet",
  homeassistant: "Imported from Home Assistant",
  claude: "Added by Claude",
  api: "Added by a script",
};

export const itemOriginList = Object.keys(ORIGIN_FILTER) as ItemOrigin[];
