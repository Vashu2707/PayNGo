/**
 * Product catalog: maps the YOLO class names (as written by smart_shelf.py)
 * to display labels and prices.
 *
 * When you train a new product, add an entry here so it shows up priced in
 * the cart UI. Unknown products fall back to a prettified label with no
 * price (excluded from the total).
 */

export interface ProductInfo {
  slug: string;
  label: string;
  price: number; // in paise-free whole rupees
}

export const PRODUCT_CATALOG: Record<string, ProductInfo> = {
  "blue-lays": { slug: "blue-lays", label: "Lays Blue", price: 20 },
  "green-lays": { slug: "green-lays", label: "Lays Green", price: 20 },
  "orange-lays": { slug: "orange-lays", label: "Lays Orange", price: 20 },
  "dark-green-lays": { slug: "dark-green-lays", label: "Lays Dark Green", price: 30 },
};

export function prettyName(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getProduct(slug: string): ProductInfo | undefined {
  return PRODUCT_CATALOG[slug];
}
