/**
 * Typical lifespans: how long a kind of thing usually lasts in a home, in years — rough, round figures from the usual
 * life-expectancy tables (manufacturers, home inspectors, the NAHB study). They're **estimates**, a starting point a
 * household can override on a category or a single thing (lib/lifespans.ts on the server). Matched by words in the
 * thing's name, then its category's path; the first match wins, so the more specific kinds come first.
 *
 * English names only: things named in another language fall back to their category, or to nothing (then a person can
 * set a lifespan on the category).
 */
export interface TypicalLifespan {
  /** Stable key (what an export or the API names it by). */
  key: string;
  /** What it's called, for "typical for a water heater". */
  name: string;
  years: number;
  /** Words that mean it, as a regular expression source matched on whole words, case-insensitively. */
  match: string;
}

export const TYPICAL_LIFESPANS: readonly TypicalLifespan[] = [
  // Heating, cooling, water
  { key: "tankless-water-heater", name: "tankless water heater", years: 20, match: "tankless (water )?heater" },
  { key: "water-heater", name: "water heater", years: 10, match: "water heater|hot water (tank|heater|cylinder)|boiler tank" },
  { key: "boiler", name: "boiler", years: 15, match: "boiler" },
  { key: "furnace", name: "furnace", years: 18, match: "furnace" },
  { key: "heat-pump", name: "heat pump", years: 15, match: "heat pump|mini[- ]?split" },
  { key: "air-conditioner", name: "air conditioner", years: 15, match: "air condition(er|ing)|a/?c unit|central air|condenser unit" },
  { key: "window-ac", name: "window air conditioner", years: 10, match: "window (a/?c|air conditioner)|portable (a/?c|air conditioner)" },
  { key: "dehumidifier", name: "dehumidifier", years: 8, match: "dehumidifier" },
  { key: "humidifier", name: "humidifier", years: 6, match: "humidifier" },
  { key: "water-softener", name: "water softener", years: 12, match: "water softener" },
  { key: "sump-pump", name: "sump pump", years: 10, match: "sump pump" },
  { key: "well-pump", name: "well pump", years: 12, match: "well pump" },
  { key: "thermostat", name: "thermostat", years: 10, match: "thermostat" },
  // Kitchen and laundry
  { key: "refrigerator", name: "refrigerator", years: 13, match: "refrigerator|fridge" },
  { key: "freezer", name: "freezer", years: 16, match: "freezer" },
  { key: "dishwasher", name: "dishwasher", years: 10, match: "dish ?washer" },
  { key: "range", name: "range or oven", years: 15, match: "range|oven|stove|cooktop|hob" },
  { key: "microwave", name: "microwave", years: 9, match: "microwave" },
  { key: "range-hood", name: "range hood", years: 14, match: "range hood|extractor (hood|fan)" },
  { key: "garbage-disposal", name: "garbage disposal", years: 12, match: "garbage disposal|disposer|waste disposal" },
  { key: "pressure-washer", name: "pressure washer", years: 8, match: "pressure washer|power washer" },
  { key: "washer", name: "washing machine", years: 11, match: "washing machine|washer" },
  { key: "hair-dryer", name: "hair dryer", years: 5, match: "hair ?dryer|blow ?dryer" },
  { key: "dryer", name: "clothes dryer", years: 13, match: "(clothes |tumble )?dryer" },
  { key: "coffee-maker", name: "coffee maker", years: 5, match: "coffee (maker|machine)|espresso machine" },
  // The house
  { key: "roof-asphalt", name: "asphalt shingle roof", years: 22, match: "roof|shingles" },
  { key: "garage-door-opener", name: "garage door opener", years: 12, match: "garage door opener" },
  { key: "garage-door", name: "garage door", years: 25, match: "garage door" },
  { key: "smoke-alarm", name: "smoke alarm", years: 10, match: "smoke (alarm|detector)" },
  { key: "co-alarm", name: "carbon monoxide alarm", years: 7, match: "(carbon monoxide|co) (alarm|detector)" },
  { key: "fire-extinguisher", name: "fire extinguisher", years: 12, match: "fire extinguisher" },
  { key: "water-filter-system", name: "whole-house water filter", years: 10, match: "whole[- ]house (water )?filter|reverse osmosis" },
  { key: "mattress", name: "mattress", years: 9, match: "mattress" },
  { key: "sofa", name: "sofa", years: 10, match: "sofa|couch|sectional|loveseat" },
  // Shop tools before electronics: a woodworking router isn't a Wi-Fi one.
  { key: "power-tool", name: "power tool", years: 12, match: "table saw|miter saw|mitre saw|band ?saw|planer|jointer|dust collector|router table|(plunge|trim|wood|palm) router|lathe|drill press" },
  // Electronics
  { key: "laptop", name: "laptop", years: 5, match: "laptop|notebook computer|macbook|chromebook" },
  { key: "desktop", name: "desktop computer", years: 6, match: "desktop( computer)?|imac|mac mini|\\bpc\\b" },
  { key: "phone", name: "smartphone", years: 3, match: "smartphone|iphone|cell ?phone|mobile phone|pixel \\d|galaxy s" },
  { key: "tablet", name: "tablet", years: 5, match: "tablet|ipad" },
  { key: "tv", name: "TV", years: 8, match: "\\btv\\b|television|oled|qled" },
  { key: "baby-monitor", name: "baby monitor", years: 5, match: "baby monitor" },
  { key: "monitor", name: "monitor", years: 7, match: "(computer |pc |gaming )?monitor" },
  { key: "printer", name: "printer", years: 5, match: "printer" },
  { key: "router", name: "Wi-Fi router", years: 5, match: "router|wi-?fi|mesh (system|node)|access point" },
  { key: "nas", name: "NAS", years: 6, match: "\\bnas\\b|network storage" },
  { key: "ups", name: "UPS battery backup", years: 5, match: "\\bups\\b|battery backup" },
  { key: "game-console", name: "game console", years: 7, match: "game console|playstation|xbox|nintendo switch|steam deck" },
  { key: "camera", name: "camera", years: 8, match: "camera|dslr|mirrorless" },
  { key: "headphones", name: "headphones", years: 4, match: "headphones|earbuds|airpods" },
  { key: "speaker", name: "speaker", years: 10, match: "speaker|soundbar|receiver|amplifier" },
  // Yard, garage, vehicles
  { key: "robot-mower", name: "robot mower", years: 6, match: "robot(ic)? (lawn ?)?mower" },
  { key: "riding-mower", name: "riding mower", years: 12, match: "riding mower|lawn tractor|zero[- ]turn" },
  { key: "lawn-mower", name: "lawn mower", years: 9, match: "(lawn ?)?mower" },
  { key: "yard-tool", name: "yard tool", years: 8, match: "leaf blower|string trimmer|weed (eater|whacker)|hedge trimmer|chainsaw" },
  { key: "snow-blower", name: "snow blower", years: 12, match: "snow ?blower|snow ?thrower" },
  { key: "generator", name: "generator", years: 15, match: "generator" },
  { key: "grill", name: "grill", years: 10, match: "grill|bbq|barbecue|smoker" },
  { key: "car-battery", name: "car battery", years: 5, match: "car battery|vehicle battery|12v battery" },
  { key: "tires", name: "tires", years: 6, match: "tires|tyres" },
  { key: "car", name: "car", years: 12, match: "\\bcar\\b|truck|suv|sedan|minivan|vehicle" },
  { key: "bicycle", name: "bicycle", years: 15, match: "bicycle|\\bbike\\b|e-?bike" },
  { key: "cordless-tool", name: "cordless tool", years: 8, match: "cordless|drill|impact driver" },
  // Small appliances last
  { key: "vacuum", name: "vacuum cleaner", years: 8, match: "vacuum|robot vac|roomba" },
  { key: "air-purifier", name: "air purifier", years: 8, match: "air purifier" },
];

// Whole words, plurals too (a category is usually "Refrigerators").
const compiled = TYPICAL_LIFESPANS.map((l) => ({ ...l, re: new RegExp(`(^|[^a-z0-9])(${l.match})(e?s)?($|[^a-z0-9])`, "i") }));

/**
 * Accessories and supplies for a thing aren't the thing: a TV stand, dust collector bags, a furnace filter, a mower
 * blade. A name with one of these words gets no typical lifespan (its category's or its own still apply).
 */
const ACCESSORY = /(^|[^a-z])(stand|mount|bracket|remote|cable|cord|charger|bags?|filters?|cart|case|cover|sleeve|adapter|parts?|blades?|bits?|belt|hose|attachment|accessor(y|ies)|kit for|replacement)($|[^a-z])/i;

/** The typical lifespan these words name (a thing's name, a category's name), or null. */
export function typicalLifespanFor(...texts: (string | null | undefined)[]): TypicalLifespan | null {
  if (texts[0] && ACCESSORY.test(texts[0])) return null;
  for (const text of texts) {
    if (!text) continue;
    const hit = compiled.find((l) => l.re.test(text));
    if (hit) return TYPICAL_LIFESPANS.find((l) => l.key === hit.key)!;
  }
  return null;
}
