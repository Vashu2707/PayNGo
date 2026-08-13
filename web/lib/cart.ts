import { Schema, model, models, type Model, type InferSchemaType } from "mongoose";
import { connectToDatabase } from "./mongodb";

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

export interface CartState {
  items: CartItem[];
  updatedAt: string | null;
}

export async function getCart(): Promise<CartState> {
  await connectToDatabase();
  const cart = await CartModel.findById("current").lean();
  return {
    items: (cart?.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity })),
    updatedAt: cart?.updatedAt ? new Date(cart.updatedAt).toISOString() : null,
  };
}

export async function clearCart(): Promise<void> {
  await connectToDatabase();
  await CartModel.updateOne(
    { _id: "current" },
    { $set: { items: [], updatedAt: new Date() } },
    { upsert: true }
  );
}
