import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { connectToDatabase } from "@/lib/mongodb";
import { EventModel } from "@/lib/cart";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store" };

/** Shelf activity is operational data — admins only. */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }

  try {
    await connectToDatabase();
    const docs = await EventModel.find().sort({ ts: -1 }).limit(10).lean();
    const events = docs.map((e) => ({
      type: e.type,
      product: e.product,
      quantity: e.quantity,
      ts: e.ts instanceof Date ? e.ts.toISOString() : String(e.ts),
    }));
    return NextResponse.json({ events }, { headers: NO_CACHE });
  } catch (err) {
    console.error("GET /api/events failed:", err);
    return NextResponse.json({ events: [] }, { status: 500, headers: NO_CACHE });
  }
}
