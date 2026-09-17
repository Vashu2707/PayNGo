import { NextResponse } from "next/server";
import { UserModel } from "@/lib/auth-model";
import { connectToDatabase } from "@/lib/mongodb";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function GET() {
  try {
    await connectToDatabase();
    const count = await UserModel.countDocuments();
    return NextResponse.json({ setupComplete: count > 0 }, { headers: NO_CACHE });
  } catch (err) {
    console.error("GET /api/auth/setup-status failed:", err);
    return NextResponse.json({ setupComplete: false, error: "db-unavailable" }, { status: 503, headers: NO_CACHE });
  }
}
