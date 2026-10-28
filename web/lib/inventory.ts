import mongoose, { Schema, model, models, type InferSchemaType, type Model, type ClientSession } from "mongoose";
import { connectToDatabase } from "./mongodb";
import { PRODUCT_CATALOG } from "./products";

/**
 * Inventory / stock model for the smart-shelf store.
 *
 * Each product slug has an `openingStock` and `stock` (current remaining units).
 * When a transaction is created we decrement stock atomically and append a
 * `stockHistory` entry, so both "how much is left" and "how much has sold"
 * are auditable per product.
 */

const stockHistoryEntrySchema = new Schema(
  {
    product: { type: String, required: true },
    quantity: { type: Number, required: true }, // positive = sold (decrement)
    type: { type: String, enum: ["sale", "restock", "adjustment"], default: "sale" },
    txnId: { type: String, default: null },
    ts: { type: Date, default: Date.now },
  },
  { _id: false }
);

const productSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    price: { type: Number, required: true },
    openingStock: { type: Number, default: 0 },
    stock: { type: Number, default: 0 },
    soldTotal: { type: Number, default: 0 },
    stockHistory: { type: [stockHistoryEntrySchema], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "products" }
);

productSchema.index({ stock: 1 });
productSchema.index({ "stockHistory.ts": -1 });

type ProductDoc = InferSchemaType<typeof productSchema>;
const productModelCtor = models.Product as Model<ProductDoc> | undefined;
const ProductModel: Model<ProductDoc> =
  productModelCtor ?? model<ProductDoc>("Product", productSchema);

export interface ProductStock {
  slug: string;
  label: string;
  price: number;
  openingStock: number;
  stock: number;
  soldTotal: number;
  stockHistory: {
    product: string;
    quantity: number;
    type: string;
    txnId: string | null;
    ts: Date;
  }[];
  updatedAt: Date;
}

function serialize(doc: Record<string, unknown>): ProductStock {
  return {
    slug: String(doc.slug),
    label: String(doc.label),
    price: Number(doc.price),
    openingStock: Number(doc.openingStock ?? 0),
    stock: Number(doc.stock ?? 0),
    soldTotal: Number(doc.soldTotal ?? 0),
    stockHistory: (doc.stockHistory as unknown[])?.map((h: any) => ({
      product: String(h.product),
      quantity: Number(h.quantity),
      type: h.type,
      txnId: h.txnId ?? null,
      ts: h.ts instanceof Date ? h.ts : new Date(h.ts),
    })) ?? [],
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date(doc.updatedAt as any),
  };
}

/**
 * Seed the products collection from PRODUCT_CATALOG with the given opening stock.
 * Idempotent: existing products keep their current stock unless --reset.
 */
export async function seedProducts(openingStock: number, reset = false): Promise<number> {
  await connectToDatabase();
  let count = 0;
  for (const [slug, info] of Object.entries(PRODUCT_CATALOG)) {
    const existing = await ProductModel.findOne({ slug }).lean();
    if (existing && !reset) {
      count++;
      continue;
    }
    await ProductModel.findOneAndUpdate(
      { slug },
      {
        $set: {
          slug,
          label: info.label,
          price: info.price,
          openingStock: reset ? openingStock : existing?.openingStock ?? openingStock,
          stock: reset ? openingStock : existing?.stock ?? openingStock,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
    count++;
  }
  return count;
}

/** Record a sale for one product, atomically decrementing stock. */
export async function recordSale(
  productSlug: string,
  quantity: number,
  txnId: string,
  session?: ClientSession
): Promise<void> {
  await connectToDatabase();
  await ProductModel.findOneAndUpdate(
    { slug: productSlug },
    {
      $inc: { stock: -quantity, soldTotal: quantity },
      $push: { stockHistory: { product: productSlug, quantity, type: "sale", txnId, ts: new Date() } },
      $set: { updatedAt: new Date() },
    },
    session ? { session } : {}
  );
}

/**
 * Idempotent sale record: only applies if this transaction has not already
 * been applied to the product (checked atomically on the update filter).
 * Safe when the verify route and the Razorpay webhook finalize concurrently,
 * including on standalone servers without multi-document transactions.
 */
export async function recordSaleOnce(
  productSlug: string,
  quantity: number,
  txnId: string,
  session?: ClientSession
): Promise<boolean> {
  await connectToDatabase();
  const res = await ProductModel.updateOne(
    { slug: productSlug, "stockHistory.txnId": { $ne: txnId } },
    {
      $inc: { stock: -quantity, soldTotal: quantity },
      $push: { stockHistory: { product: productSlug, quantity, type: "sale", txnId, ts: new Date() } },
      $set: { updatedAt: new Date() },
    },
    session ? { session } : {}
  );
  return res.modifiedCount > 0;
}

export async function restockProduct(productSlug: string, quantity: number): Promise<void> {
  await connectToDatabase();
  await ProductModel.findOneAndUpdate(
    { slug: productSlug },
    {
      $inc: { stock: quantity },
      $push: { stockHistory: { product: productSlug, quantity, type: "restock", txnId: null, ts: new Date() } },
      $set: { updatedAt: new Date() },
    }
  );
}

export async function getAllProducts(): Promise<ProductStock[]> {
  await connectToDatabase();
  const docs = await ProductModel.find().sort({ label: 1 }).lean();
  return docs.map((d) => serialize(d as unknown as Record<string, unknown>));
}

/* ── Runtime pricing ──────────────────────────────────────────────────
 * The static catalog in products.ts holds the *default* prices (and the
 * labels/emoji used everywhere). The admin can override any price from the
 * dashboard; those overrides live on the products collection and win over
 * the catalog everywhere money is computed: the live cart, transaction
 * snapshots and the Razorpay order amount.
 *
 * The merged map is cached briefly so the 1.5s cart poll does not query
 * MongoDB every tick; updateProductPrice() invalidates it immediately, so a
 * price change reaches customers on their next poll.
 */

const PRICE_CACHE_TTL_MS = 10_000;
let priceCache: { prices: Record<string, number>; at: number } | null = null;

export function invalidatePriceCache(): void {
  priceCache = null;
}

/** Catalog prices with any admin overrides from Mongo applied on top. */
export async function getEffectivePrices(): Promise<Record<string, number>> {
  const now = Date.now();
  if (priceCache && now - priceCache.at < PRICE_CACHE_TTL_MS) return priceCache.prices;

  const prices: Record<string, number> = {};
  for (const [slug, info] of Object.entries(PRODUCT_CATALOG)) {
    prices[slug] = info.price;
  }
  try {
    await connectToDatabase();
    const docs = await ProductModel.find({}, { _id: 0, slug: 1, price: 1 }).lean();
    for (const d of docs) {
      const price = Number(d.price);
      if (Number.isFinite(price)) prices[String(d.slug)] = price;
    }
  } catch (err) {
    // Fall back to catalog-only prices rather than breaking checkout.
    console.error("getEffectivePrices: could not read product overrides:", err);
  }
  priceCache = { prices, at: now };
  return prices;
}

/**
 * Set a product's price (whole rupees). Returns the updated product, or null
 * when the slug is unknown. Invalidates the price cache on success.
 */
export async function updateProductPrice(slug: string, price: number): Promise<ProductStock | null> {
  await connectToDatabase();
  const doc = await ProductModel.findOneAndUpdate(
    { slug },
    { $set: { price, updatedAt: new Date() } },
    { new: true }
  ).lean();
  if (!doc) return null;
  invalidatePriceCache();
  return serialize(doc as unknown as Record<string, unknown>);
}

export async function getProductStock(slug: string): Promise<ProductStock | null> {
  await connectToDatabase();
  const doc = await ProductModel.findOne({ slug }).lean();
  return doc ? serialize(doc as unknown as Record<string, unknown>) : null;
}

export { ProductModel };
