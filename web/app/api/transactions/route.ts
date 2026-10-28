import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { getTransactions } from "@/lib/transactions";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store" };

/**
 * Transaction history is admin-only. Customers never receive it — the store
 * page only shows the live cart and checkout.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });
  }

  try {
    const txns = await getTransactions(50);
    return NextResponse.json({ transactions: txns }, { headers: NO_CACHE });
  } catch {
    return NextResponse.json({ transactions: [] }, { status: 500, headers: NO_CACHE });
  }
}
