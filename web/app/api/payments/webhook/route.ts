import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/razorpay";
import {
  getAttemptByOrderId,
  setAttemptAuthorized,
  setAttemptFailed,
  finalizeSuccessfulPayment,
} from "@/lib/payments";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/**
 * Razorpay webhook — the authoritative out-of-band confirmation channel.
 * Verifies `x-razorpay-signature` (HMAC-SHA256 of the RAW body) against
 * RAZORPAY_WEBHOOK_SECRET, validates the event's amount against the amount
 * recorded when the order was created, stores the payment entity, and
 * finalizes the transaction idempotently (safe under retries/races with the
 * client-side verify endpoint).
 *
 * IMPORTANT: must be reachable from Razorpay's servers. For local dev, use a
 * tunnel (ngrok / cloudflared) pointing at /api/payments/webhook.
 * This endpoint does NOT rely on an auth cookie — the HMAC is the auth.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.error("[payments] Webhook rejected: missing/invalid signature.");
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 400, headers: NO_CACHE });
  }

  let payload: {
    event?: string;
    payload?: {
      payment?: { entity?: Record<string, unknown> };
      order?: { entity?: { id?: string } };
    };
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400, headers: NO_CACHE });
  }

  const event = payload.event ?? "";
  const paymentEntity = payload.payload?.payment?.entity;

  const rzpOrderId =
    (paymentEntity?.order_id as string | undefined) ?? payload.payload?.order?.entity?.id ?? "";
  const rzpPaymentId = (paymentEntity?.id as string | undefined) ?? "";

  // Events that must never finalize a payment but are still recorded.
  if (event === "payment.failed") {
    if (rzpOrderId) {
      const attempt = await getAttemptByOrderId(rzpOrderId);
      if (attempt) {
        const reason =
          (paymentEntity?.error_description as string | undefined) ||
          (paymentEntity?.error_reason as string | undefined) ||
          "Payment failed at Razorpay.";
        await setAttemptFailed(rzpOrderId, reason, {
          paymentId: rzpPaymentId || null,
          entity: paymentEntity,
        });
        return NextResponse.json(
          { status: "recorded", failureReason: reason },
          { headers: NO_CACHE }
        );
      }
    }
    return NextResponse.json({ status: "ignored" }, { headers: NO_CACHE });
  }

  if (event === "payment.authorized") {
    if (rzpOrderId && rzpPaymentId) {
      const attempt = await getAttemptByOrderId(rzpOrderId);
      if (attempt) {
        await setAttemptAuthorized(rzpOrderId, {
          paymentId: rzpPaymentId,
          method: (paymentEntity?.method as string | undefined) ?? null,
          entity: paymentEntity,
        });
        return NextResponse.json({ status: "recorded" }, { headers: NO_CACHE });
      }
    }
    return NextResponse.json({ status: "ignored" }, { headers: NO_CACHE });
  }

  if (event === "payment.captured" || event === "order.paid") {
    if (!rzpOrderId || !rzpPaymentId) {
      return NextResponse.json({ status: "ignored" }, { headers: NO_CACHE });
    }

    const attempt = await getAttemptByOrderId(rzpOrderId);
    if (!attempt) {
      console.error(`[payments] Webhook for unknown order ${rzpOrderId} (event ${event}).`);
      return NextResponse.json({ status: "ignored" }, { headers: NO_CACHE });
    }

    const entityAmount = Number(paymentEntity?.amount);
    if (Number.isFinite(entityAmount) && entityAmount !== attempt.amountPaise) {
      console.error(
        `[payments] Webhook amount mismatch for ${rzpOrderId}: event ${entityAmount} paise vs ` +
          `recorded ${attempt.amountPaise} paise — refusing to finalize.`
      );
      return NextResponse.json({ status: "amount_mismatch" }, { headers: NO_CACHE });
    }

    const res = await finalizeSuccessfulPayment({
      orderId: rzpOrderId,
      paymentId: rzpPaymentId,
      source: "webhook",
      expectedAmountPaise: attempt.amountPaise,
      entity: paymentEntity,
      method: (paymentEntity?.method as string | undefined) ?? null,
      flags: { webhookVerified: true },
    });

    if (res.ok) {
      return NextResponse.json(
        { status: "success", processed: true, alreadyProcessed: res.alreadyProcessed },
        { headers: NO_CACHE }
      );
    }
    console.error(`[payments] Webhook finalize failed for ${rzpOrderId}: ${res.reason}`);
    return NextResponse.json({ status: "error", reason: res.reason }, { headers: NO_CACHE });
  }

  return NextResponse.json({ status: "ignored" }, { headers: NO_CACHE });
}
