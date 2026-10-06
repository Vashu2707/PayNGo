import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { connectToDatabase } from "./mongodb";
import { runWithOptionalTransaction } from "./mongo-tx";
import { getProduct, prettyName } from "./products";
import { recordSaleOnce } from "./inventory";

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
    paymentMethod: { type: String, enum: ["cash", "upi", "card", "razorpay"], required: true },
    paymentStatus: { type: String, enum: ["pending", "success", "failed"], default: "success" },
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    userId: { type: String, default: null },
    cartFingerprint: { type: String, default: null },
    ts: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "transactions" }
);

transactionSchema.index({ ts: -1 });
transactionSchema.index({ paymentMethod: 1, paymentStatus: 1, userId: 1, cartFingerprint: 1 });

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
  paymentMethod: "cash" | "upi" | "card" | "razorpay";
  paymentStatus: "pending" | "success" | "failed";
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  userId?: string | null;
  cartFingerprint?: string | null;
  ts: Date;
}

type TransactionDoc = InferSchemaType<typeof transactionSchema>;
const transactionModelCtor =
  models.Transaction as Model<TransactionDoc> | undefined;
const TransactionModel: Model<TransactionDoc> =
  transactionModelCtor ?? model<TransactionDoc>("Transaction", transactionSchema);

export { TransactionModel };

export interface CheckoutResult {
  transactionId: string;
  transaction: Transaction;
}

export async function createTransaction(
  rawItems: { name: string; quantity: number }[],
  paymentMethod: "cash" | "upi" | "card" | "razorpay",
  opts: {
    paymentStatus?: "pending" | "success" | "failed";
    razorpayOrderId?: string | null;
    razorpayPaymentId?: string | null;
    userId?: string | null;
    cartFingerprint?: string | null;
  } = {}
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

  const doc = await runWithOptionalTransaction(async (session) => {
    const created = await TransactionModel.create(
      [
        {
          items,
          totalItems,
          totalAmount,
          paymentMethod,
          paymentStatus: opts.paymentStatus ?? "success",
          razorpayOrderId: opts.razorpayOrderId ?? null,
          razorpayPaymentId: opts.razorpayPaymentId ?? null,
          userId: opts.userId ?? null,
          cartFingerprint: opts.cartFingerprint ?? null,
        },
      ],
      { session }
    );
    // Record stock decrements for priced products — only for transactions
    // already considered paid (cash/upi/card). Razorpay stays "pending" until
    // the payment is verified server-side.
    const isPaid = (opts.paymentStatus ?? "success") !== "pending";
    if (isPaid) {
      for (const it of items) {
        if (it.lineTotal != null) {
          await recordSaleOnce(it.name, it.quantity, String(created[0]._id), session);
        }
      }
    }
    return created[0];
  });

  return {
    transactionId: String(doc._id),
    transaction: {
      _id: String(doc._id),
      items,
      totalItems,
      totalAmount,
      paymentMethod,
      paymentStatus: doc.paymentStatus,
      razorpayOrderId: doc.razorpayOrderId ?? null,
      razorpayPaymentId: doc.razorpayPaymentId ?? null,
      userId: doc.userId ?? null,
      cartFingerprint: doc.cartFingerprint ?? null,
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
    items: d.items.map((i) => ({
      name: i.name,
      label: i.label,
      quantity: i.quantity,
      unitPrice: i.unitPrice ?? null,
      lineTotal: i.lineTotal ?? null,
    })),
    totalItems: d.totalItems,
    totalAmount: d.totalAmount,
    paymentMethod: d.paymentMethod,
    paymentStatus: d.paymentStatus ?? "success",
    razorpayOrderId: d.razorpayOrderId ?? null,
    razorpayPaymentId: d.razorpayPaymentId ?? null,
    ts: new Date(d.ts),
  }));
}

export async function findTransactionByRazorpayOrderId(orderId: string) {
  await connectToDatabase();
  const d = await TransactionModel.findOne({ razorpayOrderId: orderId }).lean();
  if (!d) return null;
  return {
    _id: String(d._id),
    items: d.items.map((i) => ({
      name: i.name,
      label: i.label,
      quantity: i.quantity,
      unitPrice: i.unitPrice ?? null,
      lineTotal: i.lineTotal ?? null,
    })),
    totalItems: Number(d.totalItems),
    totalAmount: Number(d.totalAmount),
    paymentMethod: d.paymentMethod,
    paymentStatus: d.paymentStatus ?? "success",
    razorpayOrderId: d.razorpayOrderId ?? null,
    razorpayPaymentId: d.razorpayPaymentId ?? null,
    ts: new Date(d.ts),
  };
}

export async function setTransactionRazorpayOrderId(
  transactionId: string,
  razorpayOrderId: string
): Promise<void> {
  await connectToDatabase();
  await TransactionModel.updateOne(
    { _id: transactionId },
    { $set: { razorpayOrderId, updatedAt: new Date() } }
  );
}

export async function findTransactionById(transactionId: string) {
  await connectToDatabase();
  const d = await TransactionModel.findById(transactionId).lean();
  if (!d) return null;
  return {
    _id: String(d._id),
    items: d.items.map((i) => ({
      name: i.name,
      label: i.label,
      quantity: i.quantity,
      unitPrice: i.unitPrice ?? null,
      lineTotal: i.lineTotal ?? null,
    })),
    totalItems: Number(d.totalItems),
    totalAmount: Number(d.totalAmount),
    paymentMethod: d.paymentMethod,
    paymentStatus: d.paymentStatus ?? "success",
    razorpayOrderId: d.razorpayOrderId ?? null,
    razorpayPaymentId: d.razorpayPaymentId ?? null,
    ts: new Date(d.ts),
  };
}

/**
 * Atomically mark a transaction as paid and decrement stock for its priced
 * items. Idempotent on every layer:
 *  - `paymentStatus: { $ne: "success" }` guards the transaction flip;
 *  - `recordSaleOnce` guards each product's stock history by txn id;
 *  - optional `expectedAmountPaise` refuses to finalize on amount mismatch.
 * Returns `null` when no matching transaction exists or validation fails.
 */
export async function markTransactionSuccess(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  opts: { expectedAmountPaise?: number; source?: string } = {}
): Promise<(Transaction & { alreadyProcessed?: boolean }) | null> {
  await connectToDatabase();
  const txn = await findTransactionByRazorpayOrderId(razorpayOrderId);
  if (!txn) return null;

  const txnAmountPaise = Math.round(Number(txn.totalAmount) * 100);
  if (opts.expectedAmountPaise != null && opts.expectedAmountPaise !== txnAmountPaise) {
    console.error(
      `[payments] Refusing to finalize order ${razorpayOrderId} (source=${opts.source ?? "unknown"}): ` +
        `amount mismatch, expected ${opts.expectedAmountPaise} paise, transaction has ${txnAmountPaise} paise.`
    );
    return null;
  }

  if (txn.paymentStatus === "success") {
    return { ...txn, alreadyProcessed: true };
  }

  const finalizedByUs = await runWithOptionalTransaction(async (session) => {
    const doc = await TransactionModel.findOneAndUpdate(
      { _id: txn._id, paymentStatus: { $ne: "success" } },
      {
        $set: { paymentStatus: "success", razorpayPaymentId, updatedAt: new Date() },
      },
      { new: true, ...(session ? { session } : {}) }
    ).lean();
    if (!doc) return false;
    for (const it of txn.items) {
      if (it.lineTotal != null) {
        await recordSaleOnce(it.name, it.quantity, String(txn._id), session);
      }
    }
    return true;
  });

  const latest = await findTransactionByRazorpayOrderId(razorpayOrderId);
  if (!latest) return null;
  return { ...latest, alreadyProcessed: !finalizedByUs };
}
