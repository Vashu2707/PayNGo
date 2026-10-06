import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { verifyPaymentSignature } from "@/lib/razorpay";
import {
  getAttemptByOrderId,
  setAttemptVerification,
  setAttemptFailed,
  setAttemptAuthorized,
  verifyPaymentServerSide,
  finalizeSuccessfulPayment,
} from "@/lib/payments";
import { findTransactionByRazorpayOrderId } from "@/lib/transactions";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/**
 * Client-side success endpoint. Requires ALL of:
 *  1. a valid session (the payment must belong to the caller),
 *  2. the Razorpay checkout HMAC signature (timing-safe compare),
 *  3. a server-side `payments.fetch()` confirmation of status, order binding
 *     and exact amount — the browser is never trusted on its own.
 * Falls back to HTTP 202 "pending" when Razorpay's API is unreachable; the
 * webhook or GET /api/payments/status then finalize the payment.
 */
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

  const attempt = await getAttemptByOrderId(orderId);
  if (!attempt) {
    return NextResponse.json({ error: "Unknown payment order." }, { status: 400, headers: NO_CACHE });
  }
  if (attempt.userId && attempt.userId !== session.userId) {
    return NextResponse.json({ error: "This payment belongs to another session." }, { status: 403, headers: NO_CACHE });
  }

  // Check 1: HMAC-SHA256(order_id|payment_id) with timing-safe compare.
  if (
    !verifyPaymentSignature({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    })
  ) {
    console.error(`[payments] Signature mismatch for order ${orderId} (user ${session.userId}).`);
    return NextResponse.json(
      { error: "Payment verification failed (signature mismatch)." },
      { status: 400, headers: NO_CACHE }
    );
  }
  await setAttemptVerification(orderId, { signatureVerified: true });

  if (attempt.status === "captured") {
    const res = await finalizeSuccessfulPayment({
      orderId,
      paymentId,
      source: "verify",
      expectedAmountPaise: attempt.amountPaise,
      flags: { signatureVerified: true },
    });
    if (res.ok) {
      return NextResponse.json(
        { ok: true, alreadyProcessed: res.alreadyProcessed, transaction: res.transaction },
        { headers: NO_CACHE }
      );
    }
  }

  // Check 3: independent server-side confirmation from Razorpay's API.
  const server = await verifyPaymentServerSide(orderId, paymentId, attempt.amountPaise);

  switch (server.state) {
    case "verified": {
      const res = await finalizeSuccessfulPayment({
        orderId,
        paymentId,
        source: "verify",
        expectedAmountPaise: attempt.amountPaise,
        entity: server.payment,
        method: server.payment.method ?? null,
        flags: { signatureVerified: true, apiVerified: true },
      });
      if (res.ok) {
        return NextResponse.json(
          { ok: true, alreadyProcessed: res.alreadyProcessed, transaction: res.transaction },
          { headers: NO_CACHE }
        );
      }
      const exists = await findTransactionByRazorpayOrderId(orderId);
      return NextResponse.json(
        {
          error: exists
            ? "Payment amount does not match this order."
            : "No matching pending transaction for this order.",
        },
        { status: 400, headers: NO_CACHE }
      );
    }

    case "failed":
      await setAttemptFailed(orderId, server.reason, {
        paymentId,
        entity: server.payment,
      });
      return NextResponse.json({ error: server.reason }, { status: 400, headers: NO_CACHE });

    case "not_captured":
      // Authorized (or just created) at Razorpay — wait for capture/webhook.
      await setAttemptAuthorized(orderId, {
        paymentId,
        method: server.payment.method ?? null,
        entity: server.payment,
      });
      return NextResponse.json(
        { ok: true, pending: true, status: "processing" },
        { status: 202, headers: NO_CACHE }
      );

    case "unreachable":
    case "unconfigured":
      // Signature is valid but Razorpay's API could not be reached — do not
      // finalize on half-trusted data; let the webhook/status poll confirm it.
      return NextResponse.json(
        { ok: true, pending: true, status: "awaiting_confirmation" },
        { status: 202, headers: NO_CACHE }
      );

    case "order_mismatch":
    case "amount_mismatch":
    case "not_found":
      console.error(
        `[payments] Rejected verify for order ${orderId}: ${server.state} (user ${session.userId}).`
      );
      return NextResponse.json(
        { error: "Payment could not be confirmed with Razorpay." },
        { status: 400, headers: NO_CACHE }
      );
  }
}
