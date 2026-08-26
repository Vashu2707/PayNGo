import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";
import { connectToDatabase } from "./mongodb";
import { getProduct, prettyName } from "./products";

const cartItemSchema = new Schema(
  {
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const cartSchema = new Schema(
  {
    _id: { type: String, default: "current" },
    items: { type: [cartItemSchema], default: [] },
    updatedAt: { type: Date, default: Date.now },
    version: { type: Number, default: 0 },
  },
  { collection: "cart" }
);

export type CartItem = InferSchemaType<typeof cartItemSchema>;
export type Cart = InferSchemaType<typeof cartSchema>;

const cartModelCtor = models.Cart as Model<Cart> | undefined;
export const CartModel: Model<Cart> =
  cartModelCtor ?? model<Cart>("Cart", cartSchema);

const eventSchema = new Schema(
  {
    type: { type: String, enum: ["pick", "place"], required: true },
    product: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    ts: { type: Date, default: Date.now },
  },
  { collection: "events" }
);

eventSchema.index({ ts: -1 });

export type CartEvent = InferSchemaType<typeof eventSchema>;

const eventModelCtor = models.CartEvent as Model<CartEvent> | undefined;
export const EventModel: Model<CartEvent> =
  eventModelCtor ?? model<CartEvent>("CartEvent", eventSchema);

/** A cart item enriched with catalog data for display. */
export interface CartItemView {
  name: string;
  label: string;
  quantity: number;
  unitPrice: number | null; // null -> unknown product, excluded from total
  lineTotal: number | null;
}

export interface CartState {
  items: CartItemView[];
  totalCount: number;
  totalAmount: number;
  updatedAt: string | null;
}

export async function getCart(): Promise<CartState> {
  await connectToDatabase();
  const cart = await CartModel.findById("current").lean();

  let totalCount = 0;
  let totalAmount = 0;

  const items: CartItemView[] = (cart?.items ?? []).map((i) => {
    const product = getProduct(i.name);
    const unitPrice = product ? product.price : null;
    const lineTotal = unitPrice !== null ? unitPrice * i.quantity : null;
    totalCount += i.quantity;
    if (lineTotal !== null) totalAmount += lineTotal;
    return {
      name: i.name,
      label: product?.label ?? prettyName(i.name),
      quantity: i.quantity,
      unitPrice,
      lineTotal,
    };
  });

  return {
    items,
    totalCount,
    totalAmount,
    updatedAt: cart?.updatedAt ? new Date(cart.updatedAt).toISOString() : null,
  };
}

/**
 * Clear the cart and bump `version` so a running smart_shelf.py notices the
 * remote clear (it polls the version) and resets its own in-memory cart.
 */
export async function clearCart(): Promise<void> {
  await connectToDatabase();
  await CartModel.findOneAndUpdate(
    { _id: "current" },
    {
      $set: { items: [], updatedAt: new Date() },
      $inc: { version: 1 },
    },
    { upsert: true }
  );
}

/**
 * Return the raw cart items (without price enrichment) — used by checkout
 * to snapshot items into a transaction before clearing.
 */
export async function getRawCart(): Promise<{
  items: { name: string; quantity: number }[];
  version: number;
  updatedAt: Date | null;
}> {
  await connectToDatabase();
  const doc = await CartModel.findById("current").lean();
  return {
    items: (doc?.items ?? []).map((i) => ({
      name: i.name,
      quantity: i.quantity,
    })),
    version: doc?.version ?? 0,
    updatedAt: doc?.updatedAt ?? null,
  };
}

/**
 * Clear the cart and bump version, returning nothing — used after a
 * transaction has already been recorded.
 */
export async function clearCartRaw(): Promise<void> {
  await connectToDatabase();
  await CartModel.findOneAndUpdate(
    { _id: "current" },
    {
      $set: { items: [], updatedAt: new Date() },
      $inc: { version: 1 },
    },
    { upsert: true }
  );
}
