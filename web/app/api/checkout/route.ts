import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { createTransaction } from "@/lib/transactions";
import { getRawCart, clearCartRaw } from "@/lib/cart";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

const OFFLINE_METHODS = ["cash", "upi", "card"] as const;

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }

  try {
    const body = await req.json();
    const paymentMethod = body.paymentMethod as string;

    if (!OFFLINE_METHODS.includes(paymentMethod as (typeof OFFLINE_METHODS)[number])) {
      return NextResponse.json(
        { error: "paymentMethod must be 'cash', 'upi', or 'card'. Use /api/payments/create-order for Razorpay." },
        { status: 400, headers: NO_CACHE }
      );
    }

    const rawCart = await getRawCart();
    if (!rawCart.items.length) {
      return NextResponse.json({ error: "Cart is empty" }, { status: 400, headers: NO_CACHE });
    }

    // Offline methods are paid immediately (success) -> decrements stock.
    const result = await createTransaction(
      rawCart.items,
      paymentMethod as (typeof OFFLINE_METHODS)[number],
      {
        paymentStatus: "success",
      }
    );
    await clearCartRaw();

    return NextResponse.json({ ok: true, ...result }, { headers: NO_CACHE });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Checkout failed";
    return NextResponse.json({ error: msg }, { status: 500, headers: NO_CACHE });
  }
}
