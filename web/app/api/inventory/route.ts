import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { getAllProducts, updateProductPrice } from "@/lib/inventory";

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

/**
 * Admin-only price edit. Whole rupees; the new price takes effect on the
 * next cart poll / checkout (the price cache is invalidated immediately).
 */
export async function PATCH(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }

  let body: { slug?: unknown; price?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: NO_CACHE });
  }

  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const price =
    typeof body.price === "number"
      ? body.price
      : typeof body.price === "string" && body.price.trim() !== ""
        ? Number(body.price)
        : NaN;

  if (!slug) {
    return NextResponse.json({ error: "slug is required." }, { status: 400, headers: NO_CACHE });
  }
  if (!Number.isInteger(price) || price < 0 || price > 1_000_000) {
    return NextResponse.json(
      { error: "price must be a whole number of rupees between 0 and 1000000." },
      { status: 400, headers: NO_CACHE }
    );
  }

  try {
    const product = await updateProductPrice(slug, price);
    if (!product) {
      return NextResponse.json({ error: "Unknown product." }, { status: 404, headers: NO_CACHE });
    }
    return NextResponse.json({ ok: true, product }, { headers: NO_CACHE });
  } catch (err) {
    console.error("PATCH /api/inventory failed:", err);
    return NextResponse.json({ error: "Could not update price." }, { status: 500, headers: NO_CACHE });
  }
}
