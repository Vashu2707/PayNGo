import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { connectToDatabase } from "./mongodb";
import {
  markTransactionSuccess,
  findTransactionByRazorpayOrderId,
  type Transaction,
} from "./transactions";
import { clearCartIfMatches, cartFingerprint } from "./cart";
import {
  isRazorpayConfigured,
  fetchRazorpayPayment,
  fetchRazorpayOrder,
  fetchRazorpayOrderPayments,
} from "./razorpay";

/**
 * Razorpay payment attempts.
 *
 * One document per Razorpay *order* (i.e. per checkout attempt for a
 * transaction). Stores the full payment trail: expected amount, which of the
 * three verification channels confirmed it (client HMAC / webhook HMAC /
 * server-side Razorpay API), the raw payment entity, and failure reasons.
 *
 * Verification channels (all must be validated against `amountPaise`):
 *  1. `signatureVerified` — HMAC-SHA256 of `order_id|payment_id` in /payments/verify
 *  2. `webhookVerified`   — HMAC of the raw webhook body in /payments/webhook
 *  3. `apiVerified`       — server-side `payments.fetch()` status/amount/order check
 */

export type PaymentAttemptStatus = "created" | "pending" | "authorized" | "captured" | "failed";

const paymentAttemptSchema = new Schema(
  {
    transactionId: { type: String, required: true },
    userId: { type: String, default: null },
    razorpayOrderId: { type: String, required: true },
    razorpayPaymentId: { type: String, default: null },
    attempt: { type: Number, default: 1 },
    retryCount: { type: Number, default: 0 },
    amountPaise: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: ["created", "pending", "authorized", "captured", "failed"],
      default: "created",
    },
    signatureVerified: { type: Boolean, default: false },
    apiVerified: { type: Boolean, default: false },
    webhookVerified: { type: Boolean, default: false },
    method: { type: String, default: null },
    failureReason: { type: String, default: null },
    entity: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "payments" }
);

paymentAttemptSchema.index({ razorpayOrderId: 1 }, { unique: true });
paymentAttemptSchema.index({ transactionId: 1 });
paymentAttemptSchema.index({ razorpayPaymentId: 1 });

type AttemptDoc = InferSchemaType<typeof paymentAttemptSchema>;
const attemptModelCtor = models.PaymentAttempt as Model<AttemptDoc> | undefined;
export const PaymentAttemptModel: Model<AttemptDoc> =
  attemptModelCtor ?? model<AttemptDoc>("PaymentAttempt", paymentAttemptSchema);

export interface PaymentAttempt {
  transactionId: string;
  userId: string | null;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  attempt: number;
  retryCount: number;
  amountPaise: number;
  currency: string;
  status: PaymentAttemptStatus;
  signatureVerified: boolean;
  apiVerified: boolean;
  webhookVerified: boolean;
  method: string | null;
  failureReason: string | null;
  entity: unknown;
}

export async function getAttemptByOrderId(orderId: string): Promise<PaymentAttempt | null> {
  await connectToDatabase();
  const doc = await PaymentAttemptModel.findOne({ razorpayOrderId: orderId }).lean();
  if (!doc) return null;
  return {
    transactionId: String(doc.transactionId),
    userId: doc.userId ?? null,
    razorpayOrderId: String(doc.razorpayOrderId),
    razorpayPaymentId: doc.razorpayPaymentId ?? null,
    attempt: Number(doc.attempt ?? 1),
    retryCount: Number(doc.retryCount ?? 0),
    amountPaise: Number(doc.amountPaise),
    currency: String(doc.currency ?? "INR"),
    status: doc.status as PaymentAttemptStatus,
    signatureVerified: Boolean(doc.signatureVerified),
    apiVerified: Boolean(doc.apiVerified),
    webhookVerified: Boolean(doc.webhookVerified),
    method: doc.method ?? null,
    failureReason: doc.failureReason ?? null,
    entity: doc.entity ?? null,
  };
}

export async function countAttemptsForTransaction(transactionId: string): Promise<number> {
  await connectToDatabase();
  return PaymentAttemptModel.countDocuments({ transactionId });
}

export async function recordOrderAttempt(params: {
  transactionId: string;
  userId: string | null;
  razorpayOrderId: string;
  amountPaise: number;
  attempt: number;
}): Promise<void> {
  await connectToDatabase();
  await PaymentAttemptModel.updateOne(
    { razorpayOrderId: params.razorpayOrderId },
    {
      $set: {
        transactionId: params.transactionId,
        userId: params.userId,
        razorpayOrderId: params.razorpayOrderId,
        amountPaise: params.amountPaise,
        currency: "INR",
        attempt: params.attempt,
        updatedAt: new Date(),
      },
      $setOnInsert: { status: "created", retryCount: 0, createdAt: new Date() },
    },
    { upsert: true }
  );
}

/** Re-opens a failed attempt for another payment try on the same order. */
export async function reopenAttemptForRetry(orderId: string): Promise<void> {
  await connectToDatabase();
  await PaymentAttemptModel.updateOne(
    { razorpayOrderId: orderId, status: { $in: ["failed", "created"] } },
    { $inc: { retryCount: 1 }, $set: { status: "created", updatedAt: new Date() } }
  );
}

export async function setAttemptVerification(
  orderId: string,
  flags: { signatureVerified?: boolean; apiVerified?: boolean; webhookVerified?: boolean }
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (flags.signatureVerified !== undefined) set.signatureVerified = flags.signatureVerified;
  if (flags.apiVerified !== undefined) set.apiVerified = flags.apiVerified;
  if (flags.webhookVerified !== undefined) set.webhookVerified = flags.webhookVerified;
  await connectToDatabase();
  await PaymentAttemptModel.updateOne({ razorpayOrderId: orderId }, { $set: set });
}

export async function setAttemptAuthorized(
  orderId: string,
  params: { paymentId?: string | null; method?: string | null; entity?: unknown }
): Promise<void> {
  await connectToDatabase();
  const set: Record<string, unknown> = { status: "authorized", updatedAt: new Date() };
  if (params.paymentId) set.razorpayPaymentId = params.paymentId;
  if (params.method) set.method = params.method;
  if (params.entity !== undefined) set.entity = params.entity;
  await PaymentAttemptModel.updateOne(
    { razorpayOrderId: orderId, status: { $ne: "captured" } },
    { $set: set }
  );
}

export async function setAttemptFailed(
  orderId: string,
  failureReason: string,
  params: { paymentId?: string | null; entity?: unknown } = {}
): Promise<void> {
  await connectToDatabase();
  const set: Record<string, unknown> = {
    status: "failed",
    failureReason: failureReason.slice(0, 500),
    updatedAt: new Date(),
  };
  if (params.paymentId) set.razorpayPaymentId = params.paymentId;
  if (params.entity !== undefined) set.entity = params.entity;
  await PaymentAttemptModel.updateOne(
    { razorpayOrderId: orderId, status: { $ne: "captured" } },
    { $set: set }
  );
}

export type FinalizeResult =
  | { ok: true; transaction: Transaction & { alreadyProcessed?: boolean }; alreadyProcessed: boolean }
  | { ok: false; reason: "unknown_order" | "amount_mismatch" | "no_transaction" };

/**
 * Single funnel for "this payment succeeded": validates the amount against
 * the recorded attempt, flips the transaction idempotently, decrements stock
 * once, records which channel confirmed it, and clears the cart only when it
 * still holds the basket this payment was created for.
 */
export async function finalizeSuccessfulPayment(params: {
  orderId: string;
  paymentId: string;
  source: "verify" | "webhook" | "reconcile";
  expectedAmountPaise?: number;
  entity?: unknown;
  method?: string | null;
  flags?: { signatureVerified?: boolean; apiVerified?: boolean; webhookVerified?: boolean };
}): Promise<FinalizeResult> {
  await connectToDatabase();
  const attempt = await getAttemptByOrderId(params.orderId);
  if (!attempt) {
    console.error(`[payments] Unknown Razorpay order ${params.orderId} (source=${params.source}).`);
    return { ok: false, reason: "unknown_order" };
  }
  if (params.expectedAmountPaise != null && params.expectedAmountPaise !== attempt.amountPaise) {
    console.error(
      `[payments] Amount mismatch for order ${params.orderId} (source=${params.source}): ` +
        `event says ${params.expectedAmountPaise} paise, recorded ${attempt.amountPaise} paise.`
    );
    return { ok: false, reason: "amount_mismatch" };
  }

  const txn = await markTransactionSuccess(params.orderId, params.paymentId, {
    expectedAmountPaise: attempt.amountPaise,
    source: params.source,
  });
  if (!txn) {
    const exists = await findTransactionByRazorpayOrderId(params.orderId);
    return { ok: false, reason: exists ? "amount_mismatch" : "no_transaction" };
  }

  const set: Record<string, unknown> = {
    status: "captured",
    razorpayPaymentId: params.paymentId,
    failureReason: null,
    updatedAt: new Date(),
  };
  if (params.method ?? attempt.method) set.method = params.method ?? attempt.method;
  if (params.entity !== undefined && params.entity !== null) set.entity = params.entity;
  if (params.flags?.signatureVerified !== undefined) set.signatureVerified = params.flags.signatureVerified;
  if (params.flags?.apiVerified !== undefined) set.apiVerified = params.flags.apiVerified;
  if (params.flags?.webhookVerified !== undefined) set.webhookVerified = params.flags.webhookVerified;
  await PaymentAttemptModel.updateOne({ razorpayOrderId: params.orderId }, { $set: set });

  if (txn.paymentStatus === "success") {
    await clearCartIfMatches(cartFingerprint(txn.items));
  }

  return { ok: true, transaction: txn, alreadyProcessed: txn.alreadyProcessed === true };
}

export type ServerVerifyResult =
  | { state: "verified"; payment: RazorpayLikePayment }
  | { state: "unconfigured" }
  | { state: "unreachable" }
  | { state: "not_found" }
  | { state: "order_mismatch"; payment: RazorpayLikePayment }
  | { state: "amount_mismatch"; payment: RazorpayLikePayment }
  | { state: "not_captured"; payment: RazorpayLikePayment }
  | { state: "failed"; payment: RazorpayLikePayment; reason: string };

interface RazorpayLikePayment {
  id: string;
  status: string;
  amount: number | string;
  currency: string;
  order_id: string;
  method?: string;
  error_description?: string | null;
  error_reason?: string | null;
}

function errorStatusCode(err: unknown): number | null {
  const e = err as { statusCode?: number; error?: { statusCode?: number } } | null;
  const code = e?.statusCode ?? e?.error?.statusCode;
  return typeof code === "number" ? code : null;
}

/**
 * Independent server-side confirmation straight from Razorpay's API —
 * never trusts the browser. Checks order binding, capture status, currency
 * and the exact amount we recorded when the order was created.
 */
export async function verifyPaymentServerSide(
  orderId: string,
  paymentId: string,
  expectedAmountPaise: number
): Promise<ServerVerifyResult> {
  if (!isRazorpayConfigured()) return { state: "unconfigured" };

  let payment: RazorpayLikePayment;
  try {
    payment = (await fetchRazorpayPayment(paymentId)) as unknown as RazorpayLikePayment;
  } catch (err) {
    const status = errorStatusCode(err);
    if (status !== null && status >= 400 && status < 500) {
      console.error(`[payments] Razorpay rejected payment id ${paymentId}: ${status}`);
      return { state: "not_found" };
    }
    console.error(`[payments] Could not reach Razorpay to verify ${paymentId}:`, err);
    return { state: "unreachable" };
  }

  if (payment.order_id !== orderId) {
    console.error(`[payments] Payment ${paymentId} belongs to order ${payment.order_id}, expected ${orderId}.`);
    return { state: "order_mismatch", payment };
  }
  if (Number(payment.amount) !== expectedAmountPaise || payment.currency !== "INR") {
    console.error(
      `[payments] Payment ${paymentId} amount mismatch: got ${payment.amount} ${payment.currency}, ` +
        `expected ${expectedAmountPaise} INR paise.`
    );
    return { state: "amount_mismatch", payment };
  }
  if (payment.status === "captured") return { state: "verified", payment };
  if (payment.status === "failed") {
    return {
      state: "failed",
      payment,
      reason: payment.error_description || payment.error_reason || "Payment failed at Razorpay.",
    };
  }
  if (payment.status === "refunded") {
    return { state: "failed", payment, reason: "Payment was refunded." };
  }
  return { state: "not_captured", payment };
}

export type ReconcileResult =
  | { status: "unknown_order" }
  | { status: "success"; transaction: Transaction }
  | { status: "pending" }
  | { status: "failed"; failureReason: string | null }
  | { status: "mismatch" };

/**
 * Reconciles an order against Razorpay (source of truth) when the client-side
 * verify never ran (closed tab, network drop) or the webhook has not arrived.
 */
export async function reconcileOrder(orderId: string): Promise<ReconcileResult> {
  await connectToDatabase();
  const attempt = await getAttemptByOrderId(orderId);
  if (!attempt) return { status: "unknown_order" };

  if (attempt.status === "captured") {
    const txn = await findTransactionByRazorpayOrderId(orderId);
    if (txn && txn.paymentStatus === "success") {
      return { status: "success", transaction: txn };
    }
  }
  if (!isRazorpayConfigured()) {
    return attempt.status === "failed"
      ? { status: "failed", failureReason: attempt.failureReason }
      : { status: "pending" };
  }

  try {
    const order = (await fetchRazorpayOrder(orderId)) as unknown as { status: string };
    if (order.status === "paid") {
      const payments = await fetchRazorpayOrderPayments(orderId);
      const captured = payments.find(
        (p: RazorpayLikePayment) =>
          p.status === "captured" &&
          p.order_id === orderId &&
          Number(p.amount) === attempt.amountPaise
      );
      if (captured) {
        const res = await finalizeSuccessfulPayment({
          orderId,
          paymentId: captured.id,
          source: "reconcile",
          expectedAmountPaise: attempt.amountPaise,
          entity: captured,
          method: captured.method ?? null,
          flags: { apiVerified: true },
        });
        if (res.ok) return { status: "success", transaction: res.transaction };
        if (res.reason === "amount_mismatch") return { status: "mismatch" };
        return { status: "pending" };
      }
      console.error(
        `[payments] Order ${orderId} is paid but no captured payment matches ${attempt.amountPaise} paise.`
      );
      return { status: "mismatch" };
    }

    const payments = await fetchRazorpayOrderPayments(orderId);
    const failed = (payments as RazorpayLikePayment[]).find((p) => p.status === "failed");
    if (failed) {
      const reason = failed.error_description || failed.error_reason || "Payment failed at Razorpay.";
      await setAttemptFailed(orderId, reason, { paymentId: failed.id, entity: failed });
      return { status: "failed", failureReason: reason };
    }
    return { status: "pending" };
  } catch (err) {
    console.error(`[payments] Could not reconcile order ${orderId} with Razorpay:`, err);
    return attempt.status === "failed"
      ? { status: "failed", failureReason: attempt.failureReason }
      : { status: "pending" };
  }
}

export type PaymentStatusResult = (ReconcileResult & { attemptStatus: PaymentAttemptStatus; retryCount: number }) | null;

/** Status for the paying session only — reconciles with Razorpay on the fly. */
export async function getPaymentStatusForUser(
  orderId: string,
  userId: string
): Promise<PaymentStatusResult> {
  await connectToDatabase();
  const attempt = await getAttemptByOrderId(orderId);
  if (!attempt) return null;
  if (attempt.userId && attempt.userId !== userId) return null;

  const result = await reconcileOrder(orderId);
  if (result.status === "unknown_order") return null;
  return {
    ...result,
    attemptStatus: attempt.status,
    retryCount: attempt.retryCount,
  };
}
