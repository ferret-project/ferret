/**
 * The Open Food Facts family (openfoodfacts.org — open data, ODbL): groceries (Open Food Facts), household goods like
 * cleaning supplies, batteries and light bulbs (Open Products Facts) and toiletries (Open Beauty Facts), by barcode.
 * No key, plain fetch; they ask for a User-Agent naming the app. Only the barcode is sent. Each database is asked in
 * turn until one knows the code.
 */
import type { ProductInfo } from "@ferret/shared";
import type { ProductLookup } from "../../ports";

const USER_AGENT = "Ferret/1 (https://github.com/ferret-project/ferret)";
const FIELDS = "product_name,product_name_en,brands,quantity,categories,generic_name,image_front_url,image_url";

export const OPEN_FACTS = [
  { host: "world.openfoodfacts.org", name: "Open Food Facts" },
  { host: "world.openproductsfacts.org", name: "Open Products Facts" },
  { host: "world.openbeautyfacts.org", name: "Open Beauty Facts" },
] as const;

type Product = {
  product_name?: string;
  product_name_en?: string;
  brands?: string;
  quantity?: string;
  categories?: string;
  generic_name?: string;
  image_front_url?: string;
  image_url?: string;
};

/** The most specific category in a language-free form ("Diet beverages, Sodas" → "Sodas"; "pt:bebidas" left out). */
export function categoryOf(categories: string | undefined) {
  const parts = (categories ?? "").split(",").map((c) => c.trim()).filter((c) => c && !/^[a-z]{2}:/.test(c));
  return parts.at(-1);
}

export function toProduct(code: string, p: Product, source: string): ProductInfo | null {
  const name = (p.product_name_en?.trim() || p.product_name?.trim()) ?? "";
  if (!name) return null;
  // "400 g e": the EU's ℮ (an estimated quantity) is noise in a name.
  const quantity = p.quantity?.trim().replace(/\s+[e℮]$/i, "");
  // "Diet Coke Soft Drink 144 fl oz": the size tells packs apart (and is what a shopping list wants).
  const title = quantity && !name.toLowerCase().includes(quantity.toLowerCase()) ? `${name} ${quantity}` : name;
  const brand = p.brands?.split(",")[0]?.trim();
  const image = p.image_front_url ?? p.image_url;
  const category = categoryOf(p.categories);
  return {
    barcode: code,
    title: title.slice(0, 200),
    ...(brand ? { brand } : {}),
    ...(p.generic_name?.trim() ? { description: p.generic_name.trim() } : {}),
    ...(category ? { category } : {}),
    images: image?.startsWith("https://") ? [image] : [],
    source,
  };
}

export class OpenFactsProducts implements ProductLookup {
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async lookup(code: string): Promise<ProductInfo | null> {
    for (const db of OPEN_FACTS) {
      const res = await this.fetcher(`https://${db.host}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) continue; // some answer "not found" this way
      if (!res.ok) throw new Error(`${db.name}: HTTP ${res.status}`);
      const body = (await res.json()) as { status?: number; product?: Product };
      if (body.status !== 1 || !body.product) continue;
      const found = toProduct(code, body.product, db.name);
      if (found) return found;
    }
    return null;
  }
}
