import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { getPaymentStatusForUser } from "@/lib/payments";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

const ORDER_ID_RE = /^order_[A-Za-z0-9]{6,64}$/;

/**
 * Payment status for the signed-in payer. Reconciles against Razorpay's API
 * when the local record is still pending, so a browser refresh, a closed
 * checkout modal, or a lagging webhook all recover to the correct state.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }

  const url = new URL(req.url);
  const orderId = url.searchParams.get("orderId") ?? "";
  if (!ORDER_ID_RE.test(orderId)) {
    return NextResponse.json({ error: "Invalid order id." }, { status: 400, headers: NO_CACHE });
  }

  try {
    const result = await getPaymentStatusForUser(orderId, session.userId);
    if (!result) {
      return NextResponse.json({ error: "Unknown payment order." }, { status: 404, headers: NO_CACHE });
    }

    return NextResponse.json(
      {
        ok: true,
        status: result.status,
        attemptStatus: result.attemptStatus,
        retryCount: result.retryCount,
        failureReason: result.status === "failed" ? result.failureReason ?? null : null,
        transaction: result.status === "success" ? result.transaction : null,
      },
      { headers: NO_CACHE }
    );
  } catch (err: unknown) {
    console.error("GET /api/payments/status failed:", err);
    return NextResponse.json({ error: "Could not fetch payment status." }, { status: 500, headers: NO_CACHE });
  }
}
