import mongoose, { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
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
  txnId: string
): Promise<void> {
  await connectToDatabase();
  await ProductModel.findOneAndUpdate(
    { slug: productSlug },
    {
      $inc: { stock: -quantity, soldTotal: quantity },
      $push: { stockHistory: { product: productSlug, quantity, type: "sale", txnId, ts: new Date() } },
      $set: { updatedAt: new Date() },
    }
  );
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

export async function getProductStock(slug: string): Promise<ProductStock | null> {
  await connectToDatabase();
  const doc = await ProductModel.findOne({ slug }).lean();
  return doc ? serialize(doc as unknown as Record<string, unknown>) : null;
}

export { ProductModel };
