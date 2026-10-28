"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

interface Analytics {
  overall: { revenue: number; transactions: number; itemsSold: number };
  today: { revenue: number; transactions: number };
  perProduct: {
    slug: string;
    label: string;
    unitPrice: number;
    stockLeft: number;
    soldTotal: number;
    revenue: number;
  }[];
  dailySales: { date: string; revenue: number; transactions: number }[];
  recentStock: {
    product: string;
    quantity: number;
    type: string;
    txnId: string | null;
    ts: string;
  }[];
}

interface ProductStock {
  slug: string;
  label: string;
  price: number;
  openingStock: number;
  stock: number;
  soldTotal: number;
  updatedAt: string;
}

interface TransactionMini {
  _id: string;
  totalItems: number;
  totalAmount: number;
  paymentMethod: "cash" | "upi" | "card" | "razorpay";
  paymentStatus: "pending" | "success" | "failed";
  ts: string;
  items: { label: string; quantity: number }[];
}

function txnTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

const METHOD_EMOJI: Record<string, string> = {
  cash: "💵",
  upi: "📱",
  card: "💳",
  razorpay: "🛡️",
};

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<{ username: string; role: string } | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [products, setProducts] = useState<ProductStock[]>([]);
  const [txns, setTxns] = useState<TransactionMini[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restockQty, setRestockQty] = useState<Record<string, number>>({});
  const [restockBusy, setRestockBusy] = useState<Record<string, boolean>>({});
  // Inline price editing: draft text per slug, save-in-flight and errors.
  const [priceDraft, setPriceDraft] = useState<Record<string, string>>({});
  const [priceBusy, setPriceBusy] = useState<Record<string, boolean>>({});
  const [priceErrors, setPriceErrors] = useState<Record<string, string>>({});
  const [accountsInit, setAccountsInit] = useState(false);

  // Setup-stock state (only shown when no products exist yet).
  const [openStock, setOpenStock] = useState("20");

  useEffect(() => {
    (async () => {
      try {
        const meRes = await fetch("/api/auth/me");
        const me = await meRes.json();
        if (!me.user) {
          router.replace("/login");
          return;
        }
        if (me.user.role !== "owner") {
          // Non-admin accounts never see the dashboard.
          router.replace("/");
          return;
        }
        setUser(me.user);
        setAccountsInit(true);
      } catch {
        router.replace("/login");
      }
    })();
  }, [router]);

  const loadAll = useCallback(async () => {
    try {
      const [a, i, t] = await Promise.all([
        fetch("/api/analytics"),
        fetch("/api/inventory"),
        fetch("/api/transactions"),
      ]);
      if (!a.ok || !i.ok || !t.ok) throw new Error("Dashboard data unavailable");
      const [adata, idata, tdata] = await Promise.all([a.json(), i.json(), t.json()]);
      setAnalytics(adata.analytics);
      setProducts(idata.products ?? []);
      setTxns(tdata.transactions ?? []);
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : "Dashboard data unavailable");
    }
  }, []);

  useEffect(() => {
    if (accountsInit) loadAll();
  }, [accountsInit, loadAll]);

  const doRestock = async (slug: string) => {
    const quantity = restockQty[slug] || 0;
    if (!quantity || quantity <= 0) return;
    setRestockBusy((b) => ({ ...b, [slug]: true }));
    try {
      await fetch("/api/inventory/restock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, quantity }),
      });
      setRestockQty((q) => ({ ...q, [slug]: 0 }));
      await loadAll();
    } finally {
      setRestockBusy((b) => ({ ...b, [slug]: false }));
    }
  };

  /** Saves the edited price for one product (admin-only PATCH /api/inventory). */
  const doSetPrice = async (slug: string) => {
    const raw = (priceDraft[slug] ?? "").trim();
    const price = Number(raw);
    if (raw === "" || !Number.isInteger(price) || price < 0 || price > 1_000_000) {
      setPriceErrors((e) => ({ ...e, [slug]: "Enter whole rupees (0–1000000)." }));
      return;
    }
    setPriceBusy((b) => ({ ...b, [slug]: true }));
    setPriceErrors((e) => {
      if (!e[slug]) return e;
      const next = { ...e };
      delete next[slug];
      return next;
    });
    try {
      const res = await fetch("/api/inventory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, price }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update price.");
      setPriceDraft((d) => {
        const next = { ...d };
        delete next[slug];
        return next;
      });
      await loadAll();
    } catch (err) {
      setPriceErrors((e) => ({
        ...e,
        [slug]: err instanceof Error ? err.message : "Could not update price.",
      }));
    } finally {
      setPriceBusy((b) => ({ ...b, [slug]: false }));
    }
  };

  const doSetup = async () => {
    const openingStock = Number(openStock);
    if (!Number.isInteger(openingStock) || openingStock < 0) return;
    setBusy(true);
    try {
      await fetch("/api/inventory/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openingStock }),
      });
      await loadAll();
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  const maxDaily = Math.max(1, ...(analytics?.dailySales.map((d) => d.revenue) ?? [0]));
  const lowStock = products.filter((p) => p.stock <= 5);
  const recentStock = analytics?.recentStock ?? [];

  return (
    <div className="dash">
      <header className="dash-header">
        <h1>PayNGo Dashboard</h1>
        <div className="header-nav">
          <span className="dash-user">
            {user ? `${user.username} · ${user.role}` : "…"}
          </span>
          <button className="header-btn" onClick={() => router.push("/")}>
            Store
          </button>
          <button className="header-btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <div className="dash-body">
        {loadError && !analytics ? (
          <div className="panel">
            <div className="empty-state">{loadError}</div>
          </div>
        ) : (
          <>
            <div className="dash-stats">
              <div className="stat-card">
                <div className="stat-label">Revenue today</div>
                <div className="stat-value">{INR.format(analytics?.today.revenue ?? 0)}</div>
                <div className="stat-sub">
                  {analytics?.today.transactions ?? 0} sale(s)
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">30-day revenue</div>
                <div className="stat-value">{INR.format(analytics?.overall.revenue ?? 0)}</div>
                <div className="stat-sub">
                  {analytics?.overall.transactions ?? 0} transactions
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Items sold (30d)</div>
                <div className="stat-value">{analytics?.overall.itemsSold ?? 0}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Low stock</div>
                <div className="stat-value" style={lowStock.length ? { color: "var(--red)" } : undefined}>
                  {lowStock.length}
                </div>
                <div className="stat-sub">
                  {lowStock.length
                    ? `${lowStock.slice(0, 6).map((p) => p.label).join(", ")}${
                        lowStock.length > 6 ? ` +${lowStock.length - 6} more` : ""
                      }`
                    : "All good"}
                </div>
              </div>
            </div>

            {/* Daily sales */}
            <div className="panel" style={{ marginBottom: 16, overflow: "hidden" }}>
              <div className="panel-header">
                <div className="panel-title">Daily sales (last 30 days)</div>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 3,
                  height: 120,
                  padding: "14px 18px",
                }}
              >
                {(analytics?.dailySales ?? []).map((d) => (
                  <div
                    key={d.date}
                    title={`${d.date}: ${INR.format(d.revenue)} (${d.transactions} txns)`}
                    style={{
                      flex: 1,
                      minWidth: 2,
                      height: `${Math.max(3, Math.round((d.revenue / maxDaily) * 100))}%`,
                      background: d.revenue > 0 ? "linear-gradient(180deg,#6366f1,#4f46e5)" : "#e2e8f0",
                      borderRadius: 3,
                      boxShadow: d.revenue > 0 ? "0 2px 6px rgba(79,70,229,.25)" : undefined,
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="dash-grid">
              <div>
                {/* Inventory */}
                <div className="panel" style={{ marginBottom: 16 }}>
                  <div className="panel-header">
                    <div className="panel-title">Inventory</div>
                    <span className="panel-hint">
                      Edit ₹ and press Save — applies at checkout immediately
                    </span>
                  </div>
                  {products.length === 0 ? (
                    <div className="empty-state">
                      <p style={{ marginBottom: 12 }}>
                        No stock yet — set the opening stock for every product in the catalog.
                      </p>
                      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                        <input
                          className="restock-input"
                          style={{ width: 90, height: 42 }}
                          type="number"
                          min={0}
                          value={openStock}
                          onChange={(e) => setOpenStock(e.target.value)}
                        />
                        <button className="btn-mini" style={{ height: 42, padding: "0 16px" }} onClick={doSetup} disabled={busy}>
                          {busy ? "…" : "Set up inventory"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="panel-body">
                      {products.map((p) => {
                        const pct = p.openingStock > 0 ? Math.round((p.stock / p.openingStock) * 100) : 0;
                        const low = p.stock <= 5;
                        const draft = priceDraft[p.slug];
                        const current = String(p.price);
                        const typed = (draft ?? current).trim();
                        const typedVal = Number(typed);
                        const priceValid =
                          typed !== "" &&
                          Number.isInteger(typedVal) &&
                          typedVal >= 0 &&
                          typedVal <= 1_000_000;
                        const priceDirty = draft !== undefined && draft.trim() !== current;
                        return (
                          <div key={p.slug} className="prod-row">
                            <div className="prod-info">
                              <div className="prod-label">{p.label}</div>
                              <div className="prod-meta">
                                {p.soldTotal} sold · open {p.openingStock}
                              </div>
                            </div>
                            <div className="price-cell">
                              <div className="price-form">
                                <span className="price-currency">₹</span>
                                <input
                                  className="price-input"
                                  type="number"
                                  min={0}
                                  max={1000000}
                                  step={1}
                                  aria-label={`Price of ${p.label}`}
                                  value={draft ?? current}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setPriceDraft((d) => ({ ...d, [p.slug]: v }));
                                    setPriceErrors((err) => {
                                      if (!err[p.slug]) return err;
                                      const next = { ...err };
                                      delete next[p.slug];
                                      return next;
                                    });
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") doSetPrice(p.slug);
                                  }}
                                />
                                <button
                                  className="btn-mini btn-price"
                                  disabled={
                                    !!priceBusy[p.slug] || !priceDirty || !priceValid
                                  }
                                  onClick={() => doSetPrice(p.slug)}
                                >
                                  {priceBusy[p.slug] ? "…" : "Save"}
                                </button>
                              </div>
                              {priceErrors[p.slug] && (
                                <div className="price-error">{priceErrors[p.slug]}</div>
                              )}
                            </div>
                            <div className="prod-bar">
                              <div
                                className={`prod-bar-fill ${low ? "low" : ""}`}
                                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                              />
                            </div>
                            <div className="prod-stock-num" style={low ? { color: "var(--red)" } : undefined}>
                              {p.stock}
                            </div>
                            <div className="restock-form">
                              <input
                                className="restock-input"
                                type="number"
                                min={1}
                                value={restockQty[p.slug] ?? ""}
                                onChange={(e) =>
                                  setRestockQty((q) => ({
                                    ...q,
                                    [p.slug]: Number(e.target.value),
                                  }))
                                }
                              />
                              <button
                                className="btn-mini"
                                disabled={restockBusy[p.slug] || !(restockQty[p.slug] > 0)}
                                onClick={() => doRestock(p.slug)}
                              >
                                {restockBusy[p.slug] ? "…" : "Restock"}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Stock activity */}
                <div className="panel">
                  <div className="panel-header">
                    <div className="panel-title">Stock activity</div>
                  </div>
                  {recentStock.length === 0 ? (
                    <div className="empty-state">No stock activity yet.</div>
                  ) : (
                    <div className="history-list">
                      {recentStock.map((h, idx) => (
                        <div key={idx} className="history-item">
                          <span className={`badge ${h.type}`}>{h.type}</span>
                          <span className="history-text">
                            {h.product} · {h.quantity} unit{h.quantity !== 1 ? "s" : ""}
                          </span>
                          <span className="history-time">{txnTime(h.ts)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                {/* Transactions */}
                <div className="panel">
                  <div className="panel-header">
                    <div className="panel-title">Recent transactions</div>
                  </div>
                  {txns.length === 0 ? (
                    <div className="empty-state">No transactions yet.</div>
                  ) : (
                    <div className="txn-list-mini">
                      {txns.slice(0, 25).map((t) => (
                        <div key={t._id} className="txn-mini">
                          <div className="txn-mini-head">
                            <span className="txn-mini-amount">{INR.format(t.totalAmount)}</span>
                            <span className={`method-chip ${t.paymentStatus === "success" ? "" : t.paymentStatus}`}>
                              {METHOD_EMOJI[t.paymentMethod] ?? ""} {t.paymentMethod}
                              {t.paymentStatus !== "success" ? ` · ${t.paymentStatus}` : ""}
                            </span>
                          </div>
                          <div className="txn-mini-meta">
                            <span>
                              {t.items.slice(0, 3).map((i) => `${i.label}×${i.quantity}`).join(", ")}
                              {t.items.length > 3 ? ` +${t.items.length - 3} more` : ""}
                            </span>
                            <span>{txnTime(t.ts)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}