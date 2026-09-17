import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { getAllProducts } from "@/lib/inventory";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }
  try {
    const products = await getAllProducts();
    return NextResponse.json({ products }, { headers: NO_CACHE });
  } catch (err) {
    console.error("GET /api/inventory failed:", err);
    return NextResponse.json({ error: "Inventory unavailable" }, { status: 500, headers: NO_CACHE });
  }
}
