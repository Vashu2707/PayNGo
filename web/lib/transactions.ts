import mongoose, { Schema, model, models } from "mongoose";
import { connectToDatabase } from "./mongodb";
import { getProduct, prettyName } from "./products";

const transactionItemSchema = new Schema(
  {
    name: { type: String, required: true },
    label: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, default: null },
    lineTotal: { type: Number, default: null },
  },
  { _id: false }
);

const transactionSchema = new Schema(
  {
    items: { type: [transactionItemSchema], required: true },
    totalItems: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    paymentMethod: { type: String, enum: ["cash", "upi"], required: true },
    ts: { type: Date, default: Date.now },
  },
  { collection: "transactions" }
);

transactionSchema.index({ ts: -1 });

export interface TransactionItem {
  name: string;
  label: string;
  quantity: number;
  unitPrice: number | null;
  lineTotal: number | null;
}

export interface Transaction {
  _id: string;
  items: TransactionItem[];
  totalItems: number;
  totalAmount: number;
  paymentMethod: "cash" | "upi";
  ts: Date;
}

const TransactionModel =
  models.Transaction ?? model("Transaction", transactionSchema);

export interface CheckoutResult {
  transactionId: string;
  transaction: Transaction;
}

export async function createTransaction(
  rawItems: { name: string; quantity: number }[],
  paymentMethod: "cash" | "upi"
): Promise<CheckoutResult> {
  await connectToDatabase();

  const items: TransactionItem[] = rawItems.map((ri) => {
    const product = getProduct(ri.name);
    return {
      name: ri.name,
      label: product?.label ?? prettyName(ri.name),
      quantity: ri.quantity,
      unitPrice: product?.price ?? null,
      lineTotal: product?.price != null ? product.price * ri.quantity : null,
    };
  });

  const totalItems = items.reduce((s, i) => s + i.quantity, 0);
  const totalAmount = items.reduce(
    (s, i) => s + (i.lineTotal ?? 0),
    0
  );

  const doc = await TransactionModel.create({
    items,
    totalItems,
    totalAmount,
    paymentMethod,
  });

  return {
    transactionId: String(doc._id),
    transaction: {
      _id: String(doc._id),
      items,
      totalItems,
      totalAmount,
      paymentMethod,
      ts: doc.ts,
    },
  };
}

export async function getTransactions(limit = 50): Promise<Transaction[]> {
  await connectToDatabase();
  const docs = await TransactionModel.find()
    .sort({ ts: -1 })
    .limit(limit)
    .lean();
  return docs.map((d) => ({
    _id: String(d._id),
    items: d.items,
    totalItems: d.totalItems,
    totalAmount: d.totalAmount,
    paymentMethod: d.paymentMethod,
    ts: d.ts,
  }));
}
