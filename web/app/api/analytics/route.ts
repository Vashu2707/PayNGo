import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { getAnalytics } from "@/lib/analytics";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }

  try {
    const url = new URL(req.url);
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30));
    const analytics = await getAnalytics(days);
    return NextResponse.json({ analytics }, { headers: NO_CACHE });
  } catch (err) {
    console.error("GET /api/analytics failed:", err);
    return NextResponse.json({ error: "Analytics unavailable" }, { status: 500, headers: NO_CACHE });
  }
}
