import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { getRawCart } from "@/lib/cart";
import { createTransaction, setTransactionRazorpayOrderId, findTransactionById } from "@/lib/transactions";
import { createRazorpayOrder, getRazorpayKeyId } from "@/lib/razorpay";
import { getProduct } from "@/lib/products";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }

  try {
    const rawCart = await getRawCart();
    if (!rawCart.items.length) {
      return NextResponse.json({ error: "Cart is empty" }, { status: 400, headers: NO_CACHE });
    }

    // Compute server-side total (never trust the client's basket sum).
    let totalAmount = 0;
    for (const it of rawCart.items) {
      const product = getProduct(it.name);
      if (product) totalAmount += product.price * it.quantity;
    }
    if (totalAmount <= 0) {
      return NextResponse.json(
        { error: "Cart total is zero; nothing to pay." },
        { status: 400, headers: NO_CACHE }
      );
    }

    // Create a PENDING transaction first, then the Razorpay order.
    const result = await createTransaction(rawCart.items, "razorpay", {
      paymentStatus: "pending",
    });

    const receipt = `payngo_${result.transactionId.slice(-12)}`;
    const order = await createRazorpayOrder({
      amount: totalAmount,
      receipt,
      notes: { payngoTransactionId: result.transactionId },
    });

    // Associate the razorpay order id with the pending transaction.
    await setTransactionRazorpayOrderId(result.transactionId, order.id);
    const finalized = await findTransactionById(result.transactionId);

    return NextResponse.json(
      {
        ok: true,
        key: getRazorpayKeyId(),
        order: { id: order.id, amount: order.amount, currency: order.currency },
        transactionId: result.transactionId,
        amount: totalAmount,
        transaction: finalized,
      },
      { headers: NO_CACHE }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Could not initialize payment.";
    console.error("POST /api/payments/create-order failed:", err);
    return NextResponse.json({ error: msg }, { status: 500, headers: NO_CACHE });
  }
}
