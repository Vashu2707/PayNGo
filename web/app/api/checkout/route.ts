import { NextResponse } from "next/server";
import { createTransaction } from "@/lib/transactions";
import { getRawCart, clearCartRaw } from "@/lib/cart";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { paymentMethod } = await req.json();
    if (paymentMethod !== "cash" && paymentMethod !== "upi") {
      return NextResponse.json(
        { error: "paymentMethod must be 'cash' or 'upi'" },
        { status: 400 }
      );
    }

    const rawCart = await getRawCart();
    if (!rawCart.items.length) {
      return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
    }

    const result = await createTransaction(rawCart.items, paymentMethod);
    await clearCartRaw();

    return NextResponse.json({ ok: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Checkout failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
