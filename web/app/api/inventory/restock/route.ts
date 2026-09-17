import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { restockProduct } from "@/lib/inventory";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }
  try {
    const body = await req.json();
    const slug = typeof body.slug === "string" ? body.slug : "";
    const quantity = Number(body.quantity);
    if (!slug || !Number.isInteger(quantity) || quantity <= 0 || quantity > 100000) {
      return NextResponse.json({ error: "Invalid restock parameters." }, { status: 400, headers: NO_CACHE });
    }
    await restockProduct(slug, quantity);
    return NextResponse.json({ ok: true }, { headers: NO_CACHE });
  } catch (err) {
    console.error("POST /api/inventory/restock failed:", err);
    return NextResponse.json({ error: "Restock failed." }, { status: 500, headers: NO_CACHE });
  }
}
