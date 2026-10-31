/**
 * A realistic household for measuring search: where things are, receipts and
 * manuals (as already-transcribed text), and the searches a family would type —
 * each with the item(s) that should come back. `expect: []` means "we don't own
 * that": any result is a false alarm.
 */
export interface FixtureItem {
  name: string;
  brand?: string;
  model?: string;
  serialNumber?: string;
  notes?: string;
  /** Path below the property, e.g. ["Garage", "Shelf 2"]. */
  location: string[];
  documents?: { filename: string; description: string; text: string }[];
}

export const property = "Highland House";

export const items: FixtureItem[] = [
  { name: "Cordless drill", brand: "DeWalt", model: "DCD771C2", serialNumber: "2024184417AB", location: ["Garage", "Workbench"], notes: "20V, two batteries and charger" },
  { name: "Circular saw", brand: "Makita", location: ["Garage", "Workbench"] },
  { name: "Socket set", brand: "Craftsman", notes: "Metric and SAE, red case", location: ["Garage", "Tool chest"] },
  { name: "Snow blower", brand: "Toro", model: "Power Max 826", location: ["Garage"], notes: "Two-stage, gas" },
  { name: "Lawn mower", brand: "Honda", model: "HRX217", location: ["Shed"], notes: "Self-propelled" },
  { name: "Extension ladder", notes: "24 ft aluminum", location: ["Side yard"] },
  { name: "Pressure washer", brand: "Ryobi", location: ["Shed"] },
  { name: "Camping tent", brand: "REI", notes: "4-person, with rainfly", location: ["Attic", "Bin 3"] },
  { name: "Sleeping bags", notes: "Two, rated to 20°F", location: ["Attic", "Bin 3"] },
  { name: "Christmas lights", notes: "Warm white LED, 6 strands", location: ["Attic", "Bin 1"] },
  { name: "Artificial Christmas tree", notes: "7.5 ft, pre-lit", location: ["Attic"] },
  { name: "Stand mixer", brand: "KitchenAid", model: "KSM150PSER", serialNumber: "W1234567", notes: "Red Artisan", location: ["Kitchen", "Counter"],
    documents: [{ filename: "mixer-warranty.pdf", description: "KitchenAid stand mixer limited warranty.", text: "KitchenAid Artisan Stand Mixer - Limited Warranty\n\nLength of warranty: One year from the date of purchase. KitchenAid will pay for replacement parts and repair labor to correct defects in materials or workmanship.\n\nTo arrange service, call 1-800-541-6390 with your model and serial number." }] },
  { name: "Espresso machine", brand: "Breville", model: "Barista Express", location: ["Kitchen", "Counter"],
    documents: [{ filename: "espresso-manual.pdf", description: "Breville Barista Express instruction book.", text: "Descaling\n\nDescale the machine every 2–3 months. Fill the water tank with descaling solution and run the cleaning cycle.\n\nGrind size\n\nIf the shot runs too fast, use a finer grind setting." }] },
  { name: "Instant Pot", brand: "Instant", notes: "6 quart pressure cooker", location: ["Kitchen", "Pantry"] },
  { name: "Cast iron skillet", brand: "Lodge", notes: "12 inch", location: ["Kitchen", "Lower cabinet"] },
  { name: "TV", brand: "Samsung", model: "QN65Q80C", location: ["Living room"],
    documents: [{ filename: "tv-receipt.jpg", description: "Best Buy receipt for a Samsung 65-inch TV.", text: "BEST BUY #1123\n03/02/2025\nSAMSUNG 65\" QLED QN65Q80C   1,099.99\nGEEK SQUAD PROTECTION 3YR     179.99\nTOTAL 1,384.67" }] },
  { name: "Soundbar", brand: "Sonos", model: "Beam", location: ["Living room"] },
  { name: "Robot vacuum", brand: "iRobot", model: "Roomba j7", location: ["Hall closet"] },
  { name: "Space heater", brand: "De'Longhi", notes: "Oil-filled radiator", location: ["Basement"] },
  { name: "Dehumidifier", brand: "Frigidaire", location: ["Basement"] },
  { name: "Water heater", brand: "Rheem", model: "XG50T06EC36U1", serialNumber: "Q312345678", location: ["Basement", "Utility room"],
    documents: [{ filename: "water-heater-manual.pdf", description: "Rheem gas water heater use and care manual.", text: "Maintenance\n\nFlush the tank once a year to remove sediment. Test the temperature and pressure relief valve every six months.\n\nWarranty: 6 years on the tank and parts from the date of installation." }] },
  { name: "Bike", brand: "Trek", model: "FX 2", notes: "Blue hybrid, size M", location: ["Garage"] },
  { name: "Kayak", brand: "Old Town", notes: "10 ft, with paddle", location: ["Garage", "Ceiling rack"] },
  { name: "Fire extinguisher", brand: "First Alert", location: ["Kitchen", "Under sink"] },
  { name: "Passport folder", notes: "Family passports and birth certificates", location: ["Office", "Fire safe"] },
];

export interface FixtureQuery {
  q: string;
  /** Item names that count as right answers (any one of them in place is a hit). */
  expect: string[];
  kind: "keyword" | "intent" | "document" | "location" | "none";
}

export const queries: FixtureQuery[] = [
  // Keyword: what you'd type if you know the name.
  { q: "dewalt", expect: ["Cordless drill"], kind: "keyword" },
  { q: "drills", expect: ["Cordless drill"], kind: "keyword" },
  { q: "kitchenaid", expect: ["Stand mixer"], kind: "keyword" },
  { q: "roomba", expect: ["Robot vacuum"], kind: "keyword" },
  { q: "W1234567", expect: ["Stand mixer"], kind: "keyword" },
  { q: "1234567", expect: ["Stand mixer", "Water heater"], kind: "keyword" }, // both serials contain it
  { q: "W12345", expect: ["Stand mixer"], kind: "keyword" },
  { q: "QN65", expect: ["TV"], kind: "keyword" },
  // Intent: what it's for, not what it's called.
  { q: "something to make holes in the wall", expect: ["Cordless drill"], kind: "intent" },
  { q: "clearing snow off the driveway", expect: ["Snow blower"], kind: "intent" },
  { q: "make coffee", expect: ["Espresso machine"], kind: "intent" },
  { q: "reach the gutters", expect: ["Extension ladder"], kind: "intent" },
  { q: "stuff for a camping trip", expect: ["Camping tent", "Sleeping bags"], kind: "intent" },
  { q: "cut the grass", expect: ["Lawn mower"], kind: "intent" },
  { q: "holiday decorations", expect: ["Christmas lights", "Artificial Christmas tree"], kind: "intent" },
  { q: "baking a cake", expect: ["Stand mixer"], kind: "intent" },
  { q: "the room is too damp", expect: ["Dehumidifier"], kind: "intent" },
  { q: "it's cold in the basement", expect: ["Space heater"], kind: "intent" },
  { q: "clean the deck", expect: ["Pressure washer"], kind: "intent" },
  { q: "go out on the lake", expect: ["Kayak"], kind: "intent" },
  { q: "kitchen fire", expect: ["Fire extinguisher"], kind: "intent" },
  { q: "important papers", expect: ["Passport folder"], kind: "intent" },
  { q: "cook dinner fast", expect: ["Instant Pot"], kind: "intent" },
  // Inside documents.
  { q: "phone number for mixer repairs", expect: ["Stand mixer"], kind: "document" },
  { q: "how often should I descale", expect: ["Espresso machine"], kind: "document" },
  { q: "flush sediment", expect: ["Water heater"], kind: "document" },
  { q: "geek squad protection", expect: ["TV"], kind: "document" },
  { q: "what did I buy at best buy", expect: ["TV"], kind: "document" },
  // Where things are.
  { q: "what's in the attic", expect: ["Camping tent", "Sleeping bags", "Christmas lights", "Artificial Christmas tree"], kind: "location" },
  { q: "workbench", expect: ["Cordless drill", "Circular saw"], kind: "location" },
  { q: "fire safe", expect: ["Passport folder"], kind: "location" },
  // Things this household doesn't own: any result is a false alarm.
  { q: "toaster", expect: [], kind: "none" },
  { q: "piano", expect: [], kind: "none" },
  { q: "golf clubs", expect: [], kind: "none" },
  { q: "sewing machine", expect: [], kind: "none" },
  { q: "chainsaw", expect: [], kind: "none" },
];
