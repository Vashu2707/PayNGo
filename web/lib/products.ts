/**
 * Product catalog: maps the YOLO class names (as written by smart_shelf.py
 * from cv-ml-core/data/dataset-v2.yaml) to display labels and prices.
 *
 * Every class in dataset-v2.yaml must have an entry here — the cart UI, Mongo
 * seed and Razorpay pricing all key off this map (enforced by
 * tests/test_dataset_consistency.py).
 *
 * CLASS_NAMES mirrors dataset-v2.yaml / catalog.yaml (the source of truth for
 * labels and prices). When adding a product, edit catalog.yaml, rebuild the
 * dataset, then add its class here.
 *
 * Labels below are auto-derived from the class name; the hand-written
 * entries are kept in OVERRIDES. Prices for classes without an override are
 * placeholders (DEFAULT_PRICE) — replace them with real prices before
 * going live (checkout rejects a zero total, so every class needs a price).
 */

export interface ProductInfo {
  slug: string;
  label: string;
  price: number; // whole rupees
}

/** Class names in dataset-v2.yaml order (index == YOLO class id). */
export const CLASS_NAMES: string[] = [
  "blue-lays",
  "green-lays",
  "orange-lays",
  "dark-green-lays",
  "parle-g",
  "britannia-bourbon",
  "britannia-good-day",
  "sunfeast-marie-light",
  "cadbury-dairy-milk",
  "cadbury-5-star",
  "cadbury-munch",
  "nestle-kitkat",
  "kurkure-masala-munch",
  "thums-up",
  "sprite",
  "fanta",
  "pepsi",
  "maggi-2-minute",
];

/** Hand-written label/price overrides, keyed by class name. */
const OVERRIDES: Record<string, Partial<ProductInfo>> = {
  "blue-lays": { label: "Lays Blue", price: 1 },
  "green-lays": { label: "Lays Green", price: 1 },
  "orange-lays": { label: "Lays Orange", price: 1 },
  "dark-green-lays": { label: "Lays Dark Green", price: 1 },
  "parle-g": { label: "Parle-G Biscuit", price: 10 },
  "britannia-bourbon": { label: "Britannia Bourbon", price: 30 },
  "britannia-good-day": { label: "Britannia Good Day", price: 30 },
  "sunfeast-marie-light": { label: "Sunfeast Marie Light", price: 30 },
  "cadbury-dairy-milk": { label: "Cadbury Dairy Milk", price: 40 },
  "cadbury-5-star": { label: "Cadbury 5 Star", price: 20 },
  "cadbury-munch": { label: "Cadbury Munch", price: 20 },
  "nestle-kitkat": { label: "KitKat", price: 40 },
  "kurkure-masala-munch": { label: "Kurkure Masala Munch", price: 20 },
  "thums-up": { label: "Thums Up", price: 40 },
  "sprite": { label: "Sprite", price: 40 },
  "fanta": { label: "Fanta Orange", price: 40 },
  "pepsi": { label: "Pepsi", price: 40 },
  "maggi-2-minute": { label: "Maggi 2 Minute Noodles", price: 14 },
};

/** Placeholder price for classes without an override (whole rupees). */
const DEFAULT_PRICE = 10;

function labelFor(slug: string): string {
  if (OVERRIDES[slug]?.label) return OVERRIDES[slug].label as string;
  return slug
    .replace(/[-_]/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const PRODUCT_CATALOG: Record<string, ProductInfo> =
  Object.fromEntries(
    CLASS_NAMES.map((slug) => [
      slug,
      { slug, label: labelFor(slug), price: OVERRIDES[slug]?.price ?? DEFAULT_PRICE },
    ])
  );

/** Cart / receipt label for a class name (falls back to a prettified slug). */
export function prettyName(slug: string): string {
  return labelFor(slug);
}

export function getProduct(slug: string): ProductInfo | undefined {
  return PRODUCT_CATALOG[slug];
}

/** Hand-written emoji for classes that also have a color chip in globals.css. */
const EMOJI_OVERRIDES: Record<string, string> = {
  "blue-lays": "🔵",
  "green-lays": "🟢",
  "orange-lays": "🟠",
  "dark-green-lays": "🟤",
};

/** Category emoji for a class name — first rule wins, otherwise the default box. */
const EMOJI_RULES: [RegExp, string][] = [
  [/lays|pringles/, "🥔"],
  [/kurkure|chips|namkeen/, "🥔"],
  [/parle|bourbon|good.?day|marie|biscuit/, "🍪"],
  [/dairy.?milk|5.?star|munch|kitkat/, "🍫"],
  [/maggi|noodles/, "🍜"],
  [/thums.?up|sprite|fanta|pepsi|cola|drink/, "🥤"],
];

export function emojiFor(slug: string): string {
  if (EMOJI_OVERRIDES[slug]) return EMOJI_OVERRIDES[slug];
  for (const [re, emoji] of EMOJI_RULES) {
    if (re.test(slug)) return emoji;
  }
  return "📦";
}
