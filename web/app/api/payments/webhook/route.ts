import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/razorpay";
import { markTransactionSuccess } from "@/lib/transactions";
import { clearCart } from "@/lib/cart";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/**
 * Razorpay webhook. Verifies the `x-razorpay-signature` against the raw body
 * using RAZORPAY_WEBHOOK_SECRET. Acts as a fallback that finalizes a payment
 * even if the customer's browser closed before the client-side verify ran.
 *
 * IMPORTANT: must be reachable from Razorpay's servers. For local dev, use a
 * tunnel (ngrok / cloudflared). This endpoint does NOT rely on an auth cookie.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json(
      { error: "Invalid webhook signature." },
      { status: 400, headers: NO_CACHE }
    );
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400, headers: NO_CACHE });
  }

  const event: string = payload.event ?? "";
  const paymentEntity = payload.payload?.payment?.entity;

  if (
    (event === "payment.captured" || event === "payment.authorized" || event === "order.paid") &&
    paymentEntity
  ) {
    const rzpOrderId: string = paymentEntity.order_id ?? payload.payload?.order?.entity?.id;
    const rzpPaymentId: string = paymentEntity.id ?? "";
    if (rzpOrderId && rzpPaymentId) {
      const txn = await markTransactionSuccess(rzpOrderId, rzpPaymentId);
      if (txn) {
        await clearCart();
        return NextResponse.json({ status: "success", processed: true }, { headers: NO_CACHE });
      }
    }
  }

  return NextResponse.json({ status: "ignored" }, { headers: NO_CACHE });
}
