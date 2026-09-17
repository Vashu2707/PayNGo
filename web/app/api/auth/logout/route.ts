import { NextResponse } from "next/server";
import { destroyAuthSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export async function POST() {
  await destroyAuthSession();
  return NextResponse.json({ ok: true }, { headers: NO_CACHE });
}
