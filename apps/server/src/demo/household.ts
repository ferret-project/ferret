/**
 * The demo's sample household (lib/demo.ts plants it, and again every night): a made-up house with enough in it to
 * show what Ferret does — rooms, a box, values for the report, warranties ending soon, maintenance due and overdue, a
 * loan, stock running low. Dates are days from the day it's planted, so it always looks lived in.
 */

export const DEMO_HOUSEHOLD = { name: "Maple Street House", slug: "demo-house", timeZone: "America/Denver" };

export const DEMO_PROPERTY = {
  name: "Maple Street House",
  type: "home" as const,
  street: "1428 Maple Street",
  city: "Boulder",
  region: "CO",
  postalCode: "80302",
  country: "United States",
  yearBuilt: 1987,
  valueCents: 74_500_000,
};

/** Rooms, and places inside them ("Garage/Workbench"). */
export const DEMO_PLACES = ["Kitchen", "Living room", "Office", "Bedroom", "Garage", "Garage/Workbench", "Basement", "Basement/Storage shelf", "Laundry"];

/** A made-up shop on a demo receipt (demo/receipts.ts). */
export interface DemoStore {
  name: string;
  address: string[];
  phone: string;
  /** The time printed on its slips. */
  time?: string;
  taxRate?: number;
  footer?: string[];
}

const STORES = {
  electronics: { name: "Flatiron Electronics", address: ["1 W Flatiron Crossing Dr", "Broomfield, CO 80021"], phone: "(303) 555-0119", time: "6:12 PM", taxRate: 0.0815, footer: ["Returns within 15 days with receipt.", "Keep this receipt for your warranty."] },
  appliance: { name: "Front Range Appliance", address: ["4800 Baseline Rd", "Boulder, CO 80303"], phone: "(303) 555-0164", time: "11:05 AM" },
  kitchen: { name: "Canyon Kitchen & Home", address: ["1600 Pearl St", "Boulder, CO 80302"], phone: "(303) 555-0131", time: "1:38 PM" },
  hardware: { name: "Maple Hardware", address: ["2850 Iris Ave", "Boulder, CO 80301"], phone: "(303) 555-0108", time: "9:21 AM", footer: ["Thanks, neighbor!"] },
  cycles: { name: "Pearl Street Cycles", address: ["2030 Pearl St", "Boulder, CO 80302"], phone: "(303) 555-0177", time: "4:55 PM", footer: ["Free tune-up within 60 days."] },
  outdoors: { name: "Canyon Outfitters", address: ["1750 29th St", "Boulder, CO 80301"], phone: "(303) 555-0150", time: "3:10 PM" },
  jeweler: { name: "Pearl Street Jewelers", address: ["1144 Pearl St", "Boulder, CO 80302"], phone: "(303) 555-0193", time: "5:40 PM", taxRate: 0.08845 },
  hvac: { name: "Front Range Heating & Air", address: ["5505 Central Ave", "Boulder, CO 80301"], phone: "(303) 555-0142", time: "10:30 AM", footer: ["Labor warranted 1 year."] },
} satisfies Record<string, DemoStore>;

export interface DemoItem {
  name: string;
  place: string;
  /** "Tools/Power tools": a starter category. */
  category?: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  barcode?: string;
  description?: string;
  /** Days before the day it's planted. */
  boughtDaysAgo?: number;
  priceCents?: number;
  valueCents?: number;
  quantity?: number;
  minQuantity?: number;
  tags?: string[];
  condition?: "new" | "good" | "fair" | "poor";
  /** Its box: another demo item's name with `isContainer`. */
  inBox?: string;
  isContainer?: boolean;
  /** Days from the day it's planted (negative: already ended). */
  warrantyEndsIn?: number;
  warrantyProvider?: string;
  /** Its photo: `demo-samples/photos/<name>.webp` in the demo's files (lib/demo.ts); left out when it isn't there. */
  photo?: string;
  /** A receipt from the day it was bought (demo/receipts.ts): the thing itself, then `extras`; or just `lines`. */
  receipt?: { store: DemoStore; extras?: { text: string; cents: number }[]; lines?: { text: string; cents: number }[]; footer?: string[] };
}

export const DEMO_ITEMS: DemoItem[] = [
  // Kitchen
  { name: "Refrigerator", place: "Kitchen", category: "Appliances/Kitchen", brand: "LG", model: "LRMVS3006S", serialNumber: "203KRDA4M117", description: "French door, InstaView, craft ice", boughtDaysAgo: 340, priceCents: 249_900, valueCents: 210_000, warrantyEndsIn: 25, warrantyProvider: "LG", tags: ["insured"], photo: "refrigerator", receipt: { store: STORES.appliance, extras: [{ text: "Delivery, install & haul-away", cents: 9_900 }] } },
  { name: "Dishwasher", place: "Kitchen", category: "Appliances/Kitchen", brand: "Bosch", model: "SHPM88Z75N", serialNumber: "FD9907 01234", boughtDaysAgo: 900, priceCents: 129_900, valueCents: 90_000, warrantyEndsIn: -170, warrantyProvider: "Bosch", photo: "dishwasher", receipt: { store: STORES.appliance } },
  { name: "Stand mixer", place: "Kitchen", category: "Kitchen", brand: "KitchenAid", model: "KSM150PSER", boughtDaysAgo: 1500, priceCents: 44_999, valueCents: 25_000, description: "Artisan, empire red, with the dough hook and whisk", condition: "good", photo: "stand-mixer" },
  { name: "Espresso machine", place: "Kitchen", category: "Kitchen", brand: "Breville", model: "BES878BSS", serialNumber: "1222BES878", boughtDaysAgo: 200, priceCents: 69_995, valueCents: 60_000, warrantyEndsIn: 165, warrantyProvider: "Breville", photo: "espresso-machine", receipt: { store: STORES.kitchen, extras: [{ text: "Descaling tablets, 4 pk", cents: 1_495 }] } },
  { name: "Air fryer", place: "Kitchen", category: "Appliances/Kitchen", brand: "Ninja", model: "AF161", boughtDaysAgo: 75, priceCents: 12_999, valueCents: 11_000, warrantyEndsIn: 290, warrantyProvider: "Ninja", photo: "air-fryer", receipt: { store: STORES.kitchen } },
  { name: "Cast iron skillet", place: "Kitchen", category: "Kitchen", brand: "Lodge", model: "12″", description: "Grandma's — seasoned for forty years. Never in the dishwasher.", valueCents: 8_000, condition: "good", tags: ["heirloom"], photo: "skillet" },
  { name: "Coffee beans", place: "Kitchen", category: "Kitchen", quantity: 1, minQuantity: 2, barcode: "0011110838179", description: "Whole bean, 12 oz bags", photo: "coffee-beans" },
  // Living room
  { name: "65″ OLED TV", place: "Living room", category: "Electronics/TVs", brand: "Sony", model: "XR-65A80L", serialNumber: "4012783", boughtDaysAgo: 420, priceCents: 179_999, valueCents: 140_000, warrantyEndsIn: 310, warrantyProvider: "Flatiron Care", tags: ["insured"], photo: "tv", receipt: { store: STORES.electronics, extras: [{ text: "Flatiron Care 4-yr protection", cents: 29_999 }, { text: "Wall mount, tilting 55-90in", cents: 7_999 }] } },
  { name: "Sofa", place: "Living room", category: "Furniture", brand: "West Elm", model: "Harmony 92″", description: "Charcoal performance velvet", boughtDaysAgo: 1100, priceCents: 249_900, valueCents: 150_000, condition: "good", photo: "sofa" },
  { name: "Oil painting — mountain lake", place: "Living room", category: "Art & collectibles", description: "Signed, 24×36, bought at the Boulder art fair", boughtDaysAgo: 2400, priceCents: 120_000, valueCents: 180_000, tags: ["insured", "heirloom"], photo: "painting" },
  { name: "Turntable", place: "Living room", category: "Electronics/Audio", brand: "Audio-Technica", model: "AT-LP120XUSB", serialNumber: "AT2207155", boughtDaysAgo: 560, priceCents: 34_900, valueCents: 26_000, photo: "record-player", receipt: { store: STORES.electronics, extras: [{ text: "Record cleaning kit", cents: 2_499 }] } },
  { name: "Classical guitar", place: "Living room", category: "Art & collectibles", brand: "Córdoba", model: "C5", serialNumber: "C5-1840221", boughtDaysAgo: 1900, priceCents: 34_900, valueCents: 30_000, condition: "good", photo: "guitar" },
  { name: "Floor lamp", place: "Living room", category: "Furniture", description: "Brass tripod, linen shade", boughtDaysAgo: 650, priceCents: 18_900, valueCents: 12_000, photo: "floor-lamp" },
  // Office
  { name: "Laptop", place: "Office", category: "Electronics/Computers", brand: "Apple", model: "MacBook Pro 14″ M4", serialNumber: "C02FK3XYQ6L4", boughtDaysAgo: 150, priceCents: 199_900, valueCents: 175_000, warrantyEndsIn: 215, warrantyProvider: "AppleCare+", tags: ["insured"], photo: "laptop", receipt: { store: STORES.electronics, extras: [{ text: "AppleCare+ for MacBook Pro 14in", cents: 27_900 }] } },
  { name: "Monitor", place: "Office", category: "Electronics/Computers", brand: "Dell", model: "U2723QE", serialNumber: "CN0F3K2T", boughtDaysAgo: 600, priceCents: 57_999, valueCents: 38_000, photo: "monitor" },
  { name: "Office chair", place: "Office", category: "Furniture", brand: "Herman Miller", model: "Aeron size B", boughtDaysAgo: 1300, priceCents: 139_500, valueCents: 80_000, condition: "good", photo: "office-chair" },
  { name: "Standing desk", place: "Office", category: "Furniture", brand: "UPLIFT", model: "V2 60×30", boughtDaysAgo: 1250, priceCents: 79_900, valueCents: 45_000, photo: "standing-desk" },
  { name: "Mirrorless camera", place: "Office", category: "Electronics/Cameras", brand: "Fujifilm", model: "X-T30 II", serialNumber: "2DQ04512", boughtDaysAgo: 280, priceCents: 89_900, valueCents: 75_000, warrantyEndsIn: 85, warrantyProvider: "Fujifilm", tags: ["insured"], photo: "camera", receipt: { store: STORES.electronics, extras: [{ text: "SD card 128GB UHS-II", cents: 4_999 }] } },
  { name: "Headphones", place: "Office", category: "Electronics/Audio", brand: "Sennheiser", model: "Momentum 4", boughtDaysAgo: 330, priceCents: 37_995, valueCents: 25_000, photo: "headphones" },
  { name: "Printer", place: "Office", category: "Electronics/Computers", brand: "HP", model: "LaserJet Pro MFP 4101fdw", boughtDaysAgo: 800, priceCents: 44_900, valueCents: 20_000, photo: "printer" },
  { name: "Printer toner", place: "Office", category: "Electronics/Computers", brand: "HP", model: "148A", quantity: 0, minQuantity: 1 },
  // Bedroom
  { name: "Engagement ring", place: "Bedroom", category: "Jewelry & watches", description: "1 ct round diamond, platinum band, appraised 2024", boughtDaysAgo: 3200, priceCents: 650_000, valueCents: 780_000, tags: ["insured", "heirloom"], photo: "ring", receipt: { store: STORES.jeweler, lines: [{ text: "Platinum solitaire, 1.01 ct round brilliant, G VS1", cents: 650_000 }], footer: ["Appraisal no. PSJ-2217649 on file", "Free cleaning & inspection for life."] } },
  { name: "Watch", place: "Bedroom", category: "Jewelry & watches", brand: "Seiko", model: "SPB143", serialNumber: "1N0412", boughtDaysAgo: 700, priceCents: 120_000, valueCents: 95_000, tags: ["insured"], photo: "watch", receipt: { store: STORES.jeweler } },
  { name: "Dresser", place: "Bedroom", category: "Furniture", description: "Six drawers, white oak", boughtDaysAgo: 1700, priceCents: 129_900, valueCents: 70_000, photo: "dresser" },
  // Garage
  { name: "Cordless drill", place: "Garage/Workbench", category: "Tools/Power tools", brand: "DEWALT", model: "DCD791D2", boughtDaysAgo: 1000, priceCents: 17_900, valueCents: 9_000, photo: "drill", receipt: { store: STORES.hardware, extras: [{ text: "Drill bit set, 21 pc", cents: 2_498 }] } },
  { name: "Circular saw", place: "Garage/Workbench", category: "Tools/Power tools", brand: "SKIL", model: "5280-01", boughtDaysAgo: 500, priceCents: 5_999, valueCents: 4_000, photo: "circular-saw" },
  { name: "Grandpa's tool chest", place: "Garage/Workbench", category: "Tools/Hand tools", isContainer: true, description: "Dovetailed pine, his hand saws and planes still inside", valueCents: 60_000, tags: ["heirloom"], photo: "tool-chest" },
  { name: "Step ladder", place: "Garage", category: "Tools", brand: "Werner", model: "3-step aluminum", boughtDaysAgo: 1400, priceCents: 7_900, photo: "ladder" },
  { name: "Lawn mower", place: "Garage", category: "Tools/Garden", brand: "Toro", model: "Recycler 22″ 21445", serialNumber: "320014561", boughtDaysAgo: 450, priceCents: 44_900, valueCents: 32_000, warrantyEndsIn: 645, warrantyProvider: "Toro", photo: "lawn-mower", receipt: { store: STORES.hardware, extras: [{ text: "SAE 30 mower oil", cents: 799 }] } },
  { name: "Mountain bike", place: "Garage", category: "Sports & outdoors", brand: "Trek", model: "Fuel EX 8", serialNumber: "WTU281C0947K", boughtDaysAgo: 900, priceCents: 449_999, valueCents: 300_000, tags: ["insured"], photo: "mountain-bike", receipt: { store: STORES.cycles, extras: [{ text: "Pedals, flat, alloy", cents: 6_999 }] } },
  { name: "Snowboard", place: "Garage", category: "Sports & outdoors", brand: "Burton", model: "Custom 158", boughtDaysAgo: 380, priceCents: 64_995, valueCents: 45_000, photo: "snowboard", receipt: { store: STORES.outdoors, extras: [{ text: "Binding mount & wax", cents: 3_500 }] } },
  // Basement
  { name: "Camping box", place: "Basement/Storage shelf", isContainer: true, description: "Everything for a weekend away", photo: "camping-box" },
  { name: "Tent", place: "Basement/Storage shelf", inBox: "Camping box", category: "Sports & outdoors", brand: "REI", model: "Half Dome SL 2+", boughtDaysAgo: 1200, priceCents: 27_900, valueCents: 15_000, photo: "tent", receipt: { store: STORES.outdoors } },
  { name: "Camp stove", place: "Basement/Storage shelf", inBox: "Camping box", category: "Sports & outdoors", brand: "MSR", model: "PocketRocket 2", boughtDaysAgo: 1800, priceCents: 4_995, valueCents: 3_000, photo: "camp-stove" },
  { name: "Holiday lights", place: "Basement/Storage shelf", category: "Seasonal & decorations", quantity: 6, description: "Warm white LED strings, 50 ft each", photo: "holiday-lights" },
  { name: "Furnace", place: "Basement", category: "Appliances/Heating & cooling", brand: "Carrier", model: "59SC5A060E17", serialNumber: "2817A12345", boughtDaysAgo: 2900, priceCents: 420_000, receipt: { store: STORES.hvac, lines: [{ text: "Carrier 59SC5A060E17 gas furnace, 60k BTU", cents: 360_000 }, { text: "Install, venting & city permit", cents: 60_000 }] } },
  { name: "Furnace filter 16×25×1", place: "Basement", category: "Appliances/Heating & cooling", brand: "Filtrete", model: "MPR 1000", quantity: 2, minQuantity: 2, barcode: "0051141359483" },
  { name: "Water heater", place: "Basement", category: "Appliances", brand: "Rheem", model: "XG50T06EC36U1", boughtDaysAgo: 2100, priceCents: 89_900 },
  // Laundry
  { name: "Washer", place: "Laundry", category: "Appliances/Laundry", brand: "LG", model: "WM4000HWA", serialNumber: "112KWZN0B331", boughtDaysAgo: 760, priceCents: 99_900, valueCents: 65_000, photo: "washer", receipt: { store: STORES.appliance, lines: [{ text: "LG WM4000HWA front-load washer", cents: 99_900 }, { text: "LG DLEX4000W electric dryer", cents: 99_900 }, { text: "Delivery, install & haul-away", cents: 9_900 }] } },
  { name: "Dryer", place: "Laundry", category: "Appliances/Laundry", brand: "LG", model: "DLEX4000W", serialNumber: "112KWRA0C870", boughtDaysAgo: 760, priceCents: 99_900, valueCents: 65_000, photo: "dryer" },
];

export const DEMO_PROVIDERS = [
  { name: "Front Range Heating & Air", trade: "HVAC", phone: "(303) 555-0142", website: "https://example.com" },
  { name: "Pearl Street Plumbing", trade: "Plumber", phone: "(303) 555-0187" },
];

export interface DemoTask {
  title: string;
  item?: string;
  place?: string;
  /** Days from the day it's planted (negative: overdue). */
  dueIn: number;
  every?: { count: number; unit: "day" | "week" | "month" | "year" };
  provider?: string;
  part?: string;
}

export const DEMO_TASKS: DemoTask[] = [
  { title: "Replace the furnace filter", item: "Furnace", dueIn: -3, every: { count: 3, unit: "month" }, part: "Furnace filter 16×25×1" },
  { title: "Furnace tune-up", item: "Furnace", dueIn: 24, every: { count: 1, unit: "year" }, provider: "Front Range Heating & Air" },
  { title: "Flush the water heater", item: "Water heater", dueIn: 5, every: { count: 1, unit: "year" }, provider: "Pearl Street Plumbing" },
  { title: "Clean the dishwasher filter", item: "Dishwasher", dueIn: 12, every: { count: 1, unit: "month" } },
  { title: "Descale the espresso machine", item: "Espresso machine", dueIn: 40, every: { count: 2, unit: "month" } },
  { title: "Test the smoke alarms", place: "Bedroom", dueIn: 60, every: { count: 6, unit: "month" } },
  { title: "Clean the dryer vent", item: "Dryer", dueIn: -9, every: { count: 1, unit: "year" } },
  { title: "Sharpen the mower blade", item: "Lawn mower", dueIn: 150, every: { count: 1, unit: "year" } },
  { title: "Bike tune-up", item: "Mountain bike", dueIn: 18, every: { count: 1, unit: "year" } },
  { title: "Wax the snowboard", item: "Snowboard", dueIn: 30, every: { count: 3, unit: "month" } },
  { title: "Season the skillet", item: "Cast iron skillet", dueIn: 45, every: { count: 6, unit: "month" } },
];

/** Lent to a neighbour, due back soon. No email: the demo emails nobody but accounts. */
export const DEMO_LOAN = { item: "Circular saw", person: "Sam (next door)", sinceDaysAgo: 9, dueIn: 5 };
