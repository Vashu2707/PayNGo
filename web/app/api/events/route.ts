import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/mongodb";
import { EventModel } from "@/lib/cart";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await connectToDatabase();
    const docs = await EventModel.find().sort({ ts: -1 }).limit(10).lean();
    const events = docs.map((e) => ({
      type: e.type,
      product: e.product,
      quantity: e.quantity,
      ts: e.ts instanceof Date ? e.ts.toISOString() : String(e.ts),
    }));
    return NextResponse.json(
      { events },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("GET /api/events failed:", err);
    return NextResponse.json({ events: [] }, { status: 500 });
  }
}
