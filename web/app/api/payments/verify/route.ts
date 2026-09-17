import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { verifyPaymentSignature } from "@/lib/razorpay";
import { markTransactionSuccess } from "@/lib/transactions";
import { clearCart } from "@/lib/cart";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }

  let body: { razorpay_order_id?: unknown; razorpay_payment_id?: unknown; razorpay_signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: NO_CACHE });
  }

  const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id : "";
  const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id : "";
  const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature : "";

  if (!orderId || !paymentId || !signature) {
    return NextResponse.json(
      { error: "Missing verification parameters." },
      { status: 400, headers: NO_CACHE }
    );
  }

  // CRM signature verification with timing-safe compare.
  if (!verifyPaymentSignature({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature })) {
    return NextResponse.json(
      { error: "Payment verification failed (signature mismatch)." },
      { status: 400, headers: NO_CACHE }
    );
  }

  try {
    const txn = await markTransactionSuccess(orderId, paymentId);
    if (!txn) {
      return NextResponse.json(
        { error: "No matching pending transaction for this order." },
        { status: 400, headers: NO_CACHE }
      );
    }

    // Payment verified — safe to clear the cart.
    await clearCart();

    return NextResponse.json(
      { ok: true, alreadyProcessed: (txn as any).alreadyProcessed === true, transaction: txn },
      { headers: NO_CACHE }
    );
  } catch (err: unknown) {
    console.error("POST /api/payments/verify failed:", err);
    return NextResponse.json(
      { error: "Payment verification failed. Please try again." },
      { status: 500, headers: NO_CACHE }
    );
  }
}
