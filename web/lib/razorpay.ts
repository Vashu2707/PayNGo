import Razorpay from "razorpay";
import crypto from "crypto";

/**
 * Server-side Razorpay integration ported from the qrfast project.
 * Never exposes the secret to the browser.
 */
export function getRazorpayClient() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error("Razorpay credentials are not configured.");
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
}

/** Publishable key ID — safe to expose; used by the checkout SDK on the client. */
export function getRazorpayKeyId(): string | null {
  return process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID || null;
}

export async function createRazorpayOrder(opts: {
  amount: number;      // in rupees (whole)
  receipt: string;
  notes?: Record<string, string>;
}): Promise<{ id: string; amount: number; currency: string }> {
  const rzp = getRazorpayClient();
  const order = await rzp.orders.create({
    amount: Math.round(opts.amount * 100), // paise
    currency: "INR",
    receipt: opts.receipt,
    notes: opts.notes,
    payment: { capture: "automatic" },
  });
  return {
    id: order.id,
    amount: Number(order.amount),
    currency: order.currency,
  };
}

/**
 * Verify the Razorpay checkout-signature (HMAC-SHA256). This must be checked
 * server-side before trusting that a payment succeeded. Uses timingSafeEqual
 * to avoid timing-attack leaks.
 */
export function verifyPaymentSignature(params: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${params.razorpay_order_id}|${params.razorpay_payment_id}`)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const sigBuf = Buffer.from(params.razorpay_signature, "utf8");

  return expectedBuf.length === sigBuf.length && crypto.timingSafeEqual(expectedBuf, sigBuf);
}

/**
 * Verify a Razorpay webhook payload against the `x-razorpay-signature` header
 * using `RAZORPAY_WEBHOOK_SECRET`. The HMAC is computed over the raw body.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const sigBuf = Buffer.from(signature, "utf8");
  return expectedBuf.length === sigBuf.length && crypto.timingSafeEqual(expectedBuf, sigBuf);
}
