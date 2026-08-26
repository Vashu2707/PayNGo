import { NextResponse } from "next/server";
import { getCart } from "@/lib/cart";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cart = await getCart();
    return NextResponse.json(
      { ...cart, syncedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("GET /api/cart failed:", err);
    return NextResponse.json({ error: "Cart unavailable" }, { status: 500 });
  }
}
