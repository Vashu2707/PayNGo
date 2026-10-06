import { connectToDatabase } from "./mongodb";
import { TransactionModel } from "./transactions";
import { ProductModel } from "./inventory";

export interface AnalyticsSummary {
  overall: {
    revenue: number;
    transactions: number;
    itemsSold: number;
  };
  today: {
    revenue: number;
    transactions: number;
  };
  perProduct: {
    slug: string;
    label: string;
    unitPrice: number;
    stockLeft: number;
    soldTotal: number;
    revenue: number;
  }[];
  dailySales: {
    date: string; // YYYY-MM-DD
    revenue: number;
    transactions: number;
  }[];
  recentStock: {
    product: string;
    quantity: number;
    type: string;
    txnId: string | null;
    ts: Date;
  }[];
}

function startOfTodayUTC(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function getAnalytics(days = 30): Promise<AnalyticsSummary> {
  await connectToDatabase();

  const todayStart = startOfTodayUTC();

  const [txns, todayTxns, products, recentHistory] = await Promise.all([
    // Only settled payments count as revenue — pending/failed Razorpay
    // attempts must never inflate the dashboard.
    TransactionModel.find({ paymentStatus: "success" }).lean(),
    TransactionModel.find({
      paymentStatus: "success",
      ts: { $gte: todayStart },
    }).lean(),
    ProductModel.find().lean(),
    ProductModel.aggregate([
      { $unwind: "$stockHistory" },
      { $sort: { "stockHistory.ts": -1 } },
      { $limit: 50 },
      {
        $project: {
          product: "$stockHistory.product",
          quantity: "$stockHistory.quantity",
          type: "$stockHistory.type",
          txnId: "$stockHistory.txnId",
          ts: "$stockHistory.ts",
        },
      },
    ]),
  ]);

  const overallRevenue = txns.reduce((s, t) => s + Number(t.totalAmount ?? 0), 0);
  const overallItems = txns.reduce((s, t) => s + Number(t.totalItems ?? 0), 0);
  const todayRevenue = todayTxns.reduce((s, t) => s + Number(t.totalAmount ?? 0), 0);

  const perProduct = products.map((p: any) => ({
    slug: String(p.slug),
    label: String(p.label),
    unitPrice: Number(p.price ?? 0),
    stockLeft: Number(p.stock ?? 0),
    soldTotal: Number(p.soldTotal ?? 0),
    revenue: Number(p.soldTotal ?? 0) * Number(p.price ?? 0),
  }));

  // Daily sales buckets for the last `days` days.
  const dailyMap = new Map<string, { revenue: number; transactions: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyMap.set(key, { revenue: 0, transactions: 0 });
  }
  for (const t of txns) {
    const key = new Date(t.ts).toISOString().slice(0, 10);
    if (dailyMap.has(key)) {
      const bucket = dailyMap.get(key)!;
      bucket.revenue += Number(t.totalAmount ?? 0);
      bucket.transactions += 1;
    }
  }
  const dailySales = Array.from(dailyMap.entries()).map(([date, v]) => ({ date, ...v }));

  return {
    overall: { revenue: overallRevenue, transactions: txns.length, itemsSold: overallItems },
    today: { revenue: todayRevenue, transactions: todayTxns.length },
    perProduct,
    dailySales,
    recentStock: recentHistory.map((h: any) => ({
      product: String(h.product),
      quantity: Number(h.quantity),
      type: String(h.type),
      txnId: h.txnId ?? null,
      ts: h.ts instanceof Date ? h.ts : new Date(h.ts),
    })),
  };
}
