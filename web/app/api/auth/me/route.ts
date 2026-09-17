import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ user: null }, { headers: NO_CACHE });
  }
  return NextResponse.json(
    { user: { _id: user._id, username: user.username, role: user.role } },
    { headers: NO_CACHE }
  );
}
