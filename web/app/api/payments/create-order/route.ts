import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { getRawCart, cartFingerprint, clearCartIfMatches } from "@/lib/cart";
import {
  createTransaction,
  setTransactionRazorpayOrderId,
  findTransactionById,
  TransactionModel,
} from "@/lib/transactions";
import { createRazorpayOrder, getRazorpayKeyId, isRazorpayConfigured } from "@/lib/razorpay";
import { getProduct } from "@/lib/products";
import { connectToDatabase } from "@/lib/mongodb";
import {
  getAttemptByOrderId,
  recordOrderAttempt,
  countAttemptsForTransaction,
  reopenAttemptForRetry,
  reconcileOrder,
} from "@/lib/payments";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }

  // Which online rail the cashier selected. Both settle through Razorpay;
  // this only decides the checkout's payment-method filter and how the
  // transaction is labelled. Legacy callers that omit it get "razorpay".
  let body: { method?: unknown } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: NO_CACHE });
  }
  const rawMethod = typeof body.method === "string" ? body.method : "";
  if (rawMethod !== "" && rawMethod !== "upi" && rawMethod !== "card" && rawMethod !== "razorpay") {
    return NextResponse.json(
      { error: "method must be 'upi', 'card', or 'razorpay'." },
      { status: 400, headers: NO_CACHE }
    );
  }
  const preferredMethod: "upi" | "card" | "razorpay" =
    rawMethod === "upi" || rawMethod === "card" ? rawMethod : "razorpay";

  try {
    if (!isRazorpayConfigured()) {
      return NextResponse.json(
        { error: "Razorpay credentials are not configured." },
        { status: 503, headers: NO_CACHE }
      );
    }

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

    const amountPaise = Math.round(totalAmount * 100);
    const fingerprint = cartFingerprint(rawCart.items);
    const userId = session.userId;
    const key = getRazorpayKeyId();

    await connectToDatabase();

    // Retry path: reuse the still-pending online transaction for this exact
    // cart instead of creating a duplicate every time the cashier retries.
    // (Historic rows used paymentMethod "razorpay"; UPI/card-labelled rows
    // come from the current flow — all of them settle via Razorpay.)
    const pending = await TransactionModel.findOne({
      paymentMethod: { $in: ["razorpay", "upi", "card"] },
      paymentStatus: "pending",
      userId,
      cartFingerprint: fingerprint,
    })
      .sort({ ts: -1 })
      .lean();

    let transactionId: string | null = pending ? String(pending._id) : null;

    if (pending && pending.paymentMethod !== preferredMethod) {
      // Cashier switched rails (e.g. UPI → Card) for the same cart — relabel
      // the pending transaction so receipts/dashboard match what is used.
      await TransactionModel.updateOne(
        { _id: pending._id, paymentStatus: "pending" },
        { $set: { paymentMethod: preferredMethod, updatedAt: new Date() } }
      );
    }

    if (pending?.razorpayOrderId) {
      const orderId = pending.razorpayOrderId;
      const rec = await reconcileOrder(orderId);

      if (rec.status === "success") {
        await clearCartIfMatches(fingerprint);
        return NextResponse.json(
          {
            ok: true,
            alreadyPaid: true,
            key,
            order: null,
            transactionId,
            amount: totalAmount,
            transaction: rec.transaction,
          },
          { headers: NO_CACHE }
        );
      }

      if (rec.status === "mismatch") {
        return NextResponse.json(
          { error: "Payment amount mismatch detected. Please contact support." },
          { status: 409, headers: NO_CACHE }
        );
      }

      const attempt = await getAttemptByOrderId(orderId);
      const sameAmount = attempt ? attempt.amountPaise === amountPaise : false;

      if (attempt && sameAmount) {
        if (rec.status === "pending" && attempt.status === "authorized") {
          // Money is debited, capture still in flight — client should poll.
          return NextResponse.json(
            {
              ok: true,
              processing: true,
              key,
              orderId,
              transactionId,
              amount: totalAmount,
              transaction: await findTransactionById(transactionId!),
            },
            { headers: NO_CACHE }
          );
        }
        if (rec.status === "pending" || rec.status === "failed") {
          // Unpaid order → reopen it and let the customer retry on the same order.
          await reopenAttemptForRetry(orderId);
          return NextResponse.json(
            {
              ok: true,
              key,
              order: { id: orderId, amount: attempt.amountPaise, currency: attempt.currency },
              transactionId,
              amount: attempt.amountPaise / 100,
              attempt: attempt.attempt,
              retried: true,
              transaction: await findTransactionById(transactionId!),
            },
            { headers: NO_CACHE }
          );
        }
        // Not reusable as-is (e.g. captured without finalize) — mint a fresh
        // Razorpay order for the same pending transaction below.
      } else {
        // Cart repriced since the attempt, or attempt record missing — abandon
        // this pending transaction and start clean at the current price.
        await TransactionModel.updateOne(
          { _id: pending._id, paymentStatus: "pending" },
          { $set: { paymentStatus: "failed", updatedAt: new Date() } }
        );
        transactionId = null;
      }
    }

    if (!transactionId) {
      const result = await createTransaction(rawCart.items, preferredMethod, {
        paymentStatus: "pending",
        userId,
        cartFingerprint: fingerprint,
      });
      transactionId = result.transactionId;
    }

    // Expire any other stale pending online transactions for this user so
    // abandoned attempts cannot pile up. Success finalize is still allowed to
    // flip a "failed" transaction to "success" if their payment lands later.
    await TransactionModel.updateMany(
      {
        paymentMethod: { $in: ["razorpay", "upi", "card"] },
        paymentStatus: "pending",
        userId,
        _id: { $ne: transactionId },
      },
      { $set: { paymentStatus: "failed", updatedAt: new Date() } }
    );

    const receipt = `payngo_${transactionId.slice(-12)}`;
    let order: { id: string; amount: number; currency: string };
    try {
      order = await createRazorpayOrder({
        amount: totalAmount,
        receipt,
        notes: { payngoTransactionId: transactionId, cartFingerprint: fingerprint.slice(0, 16) },
      });
    } catch (err) {
      // The transaction stays pending without an order id — the next retry
      // reuses it instead of leaking another duplicate.
      console.error("POST /api/payments/create-order: Razorpay order creation failed:", err);
      return NextResponse.json(
        { error: "Could not initialize payment with Razorpay. Please try again." },
        { status: 502, headers: NO_CACHE }
      );
    }

    const attemptNo = (await countAttemptsForTransaction(transactionId)) + 1;
    await recordOrderAttempt({
      transactionId,
      userId,
      razorpayOrderId: order.id,
      amountPaise,
      attempt: attemptNo,
    });
    await setTransactionRazorpayOrderId(transactionId, order.id);
    const finalized = await findTransactionById(transactionId);

    return NextResponse.json(
      {
        ok: true,
        key,
        order: { id: order.id, amount: order.amount, currency: order.currency },
        transactionId,
        amount: totalAmount,
        attempt: attemptNo,
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
