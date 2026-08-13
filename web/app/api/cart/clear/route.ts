import { NextResponse } from "next/server";
import { clearCart } from "@/lib/cart";

export async function POST() {
  try {
    await clearCart();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("POST /api/cart/clear failed:", err);
    return NextResponse.json({ error: "Could not clear cart" }, { status: 500 });
  }
}
