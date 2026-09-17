import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { seedProducts } from "@/lib/inventory";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }
  try {
    const body = await req.json();
    const openingStock = Number(body.openingStock ?? 0);
    const reset = body.reset === true;
    if (!Number.isInteger(openingStock) || openingStock < 0 || openingStock > 1000000) {
      return NextResponse.json({ error: "openingStock must be a non-negative integer." }, { status: 400, headers: NO_CACHE });
    }
    const seeded = await seedProducts(openingStock, reset);
    return NextResponse.json({ ok: true, seeded }, { headers: NO_CACHE });
  } catch (err) {
    console.error("POST /api/inventory/setup failed:", err);
    return NextResponse.json({ error: "Setup failed." }, { status: 500, headers: NO_CACHE });
  }
}
