import { NextResponse } from "next/server";
import { getTransactions } from "@/lib/transactions";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const txns = await getTransactions(50);
    return NextResponse.json(
      { transactions: txns },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { transactions: [] },
      { status: 500 }
    );
  }
}
