"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ── Types ──────────────────────────────────────────────────────── */

interface CartItem {
  name: string;
  label: string;
  quantity: number;
  unitPrice: number | null;
  lineTotal: number | null;
}

interface CartState {
  items: CartItem[];
  totalCount: number;
  totalAmount: number;
  updatedAt: string | null;
}

interface TxnItem {
  name: string;
  label: string;
  quantity: number;
  unitPrice: number | null;
  lineTotal: number | null;
}

interface Transaction {
  _id: string;
  items: TxnItem[];
  totalItems: number;
  totalAmount: number;
  paymentMethod: "cash" | "upi";
  ts: string;
}

/* ── Constants ──────────────────────────────────────────────────── */

const POLL_MS = 1500;
const LIVE_MS = 6000;

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const PRODUCT_EMOJI: Record<string, string> = {
  "blue-lays": "🔵",
  "green-lays": "🟢",
  "orange-lays": "🟠",
  "dark-green-lays": "🟤",
};

/* ── Helpers ────────────────────────────────────────────────────── */

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function txnTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function txnDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

/* ── Checkout modal ─────────────────────────────────────────────── */

function CheckoutModal({
  items,
  totalAmount,
  totalCount,
  onConfirm,
  onClose,
}: {
  items: CartItem[];
  totalAmount: number;
  totalCount: number;
  onConfirm: (method: "cash" | "upi") => void;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<"cash" | "upi">("cash");
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    await onConfirm(method);
    setBusy(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Checkout</h3>
        <p className="subtitle">{totalCount} item{totalCount !== 1 ? "s" : ""} in cart</p>

        <div className="modal-items">
          {items.map((it) => (
            <div key={it.name} className="modal-item">
              <span className="modal-item-name">{it.label}</span>
              <span className="modal-item-detail">
                {it.quantity} × {it.unitPrice != null ? INR.format(it.unitPrice) : "—"}
                {it.lineTotal != null && ` = ${INR.format(it.lineTotal)}`}
              </span>
            </div>
          ))}
        </div>

        <div className="modal-total">
          <span className="label">Total</span>
          <span className="amount">{INR.format(totalAmount)}</span>
        </div>

        <p style={{ fontSize: 13, fontWeight: 600, color: "#64748b", marginBottom: 8 }}>
          Payment method
        </p>
        <div className="modal-pay-methods">
          <button
            className={`pay-btn ${method === "cash" ? "selected" : ""}`}
            onClick={() => setMethod("cash")}
          >
            💵 Cash
          </button>
          <button
            className={`pay-btn ${method === "upi" ? "selected" : ""}`}
            onClick={() => setMethod("upi")}
          >
            📱 UPI
          </button>
        </div>

        <div className="modal-actions">
          <button className="btn btn-cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-confirm" onClick={handleConfirm} disabled={busy}>
            {busy ? "Processing…" : "Confirm Payment"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Receipt modal ──────────────────────────────────────────────── */

function ReceiptModal({
  txn,
  onClose,
}: {
  txn: Transaction;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal receipt" onClick={(e) => e.stopPropagation()}>
        <div className="checkmark">✓</div>
        <h3>Payment Successful</h3>
        <p className="receipt-id">#{txn._id.slice(-8).toUpperCase()}</p>

        <div className="receipt-items">
          {txn.items.map((it) => (
            <div key={it.name} className="receipt-item">
              <span>
                {it.label} × {it.quantity}
              </span>
              <span>{it.lineTotal != null ? INR.format(it.lineTotal) : "—"}</span>
            </div>
          ))}
          <div className="receipt-divider" />
          <div className="receipt-total">
            <span>Total</span>
            <span>{INR.format(txn.totalAmount)}</span>
          </div>
        </div>

        <div className="receipt-meta">
          {txn.paymentMethod.toUpperCase()} · {txnTime(txn.ts)} · {txnDate(txn.ts)}
        </div>

        <button className="btn btn-confirm" onClick={onClose} style={{ maxWidth: 200, margin: "0 auto" }}>
          Done
        </button>
      </div>
    </div>
  );
}

/* ── Main page ──────────────────────────────────────────────────── */

export default function Home() {
  const [cart, setCart] = useState<CartState>({
    items: [],
    totalCount: 0,
    totalAmount: 0,
    updatedAt: null,
  });
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCheckout, setShowCheckout] = useState(false);
  const [receipt, setReceipt] = useState<Transaction | null>(null);
  const [, setTick] = useState(0);

  const hiddenRef = useRef(false);
  const prevCartRef = useRef("");

  const fetchCart = useCallback(async () => {
    try {
      const res = await fetch("/api/cart");
      if (!res.ok) throw new Error("Cart unavailable");
      const data: CartState = await res.json();
      setCart(data);
      setError(null);
    } catch {
      setError("Camera offline — cart unavailable");
    }
  }, []);

  const fetchTxns = useCallback(async () => {
    try {
      const res = await fetch("/api/transactions");
      if (!res.ok) return;
      const data = await res.json();
      setTxns(data.transactions ?? []);
    } catch {
      /* silent */
    }
  }, []);

  /* Polling with visibility pause */
  useEffect(() => {
    fetchCart();
    fetchTxns();
    const id = setInterval(() => {
      if (!hiddenRef.current) {
        fetchCart();
        fetchTxns();
      }
    }, POLL_MS);
    const onVis = () => {
      hiddenRef.current = document.hidden;
      if (!hiddenRef.current) {
        fetchCart();
        fetchTxns();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [fetchCart, fetchTxns]);

  /* Force tick every 5s for relative timestamps */
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  /* Re-fetch txns when cart changes */
  useEffect(() => {
    const snap = JSON.stringify(cart.items);
    if (snap !== prevCartRef.current) {
      prevCartRef.current = snap;
      if (!hiddenRef.current) fetchTxns();
    }
  }, [cart.items, fetchTxns]);

  const isLive =
    cart.updatedAt != null &&
    Date.now() - new Date(cart.updatedAt).getTime() < LIVE_MS;

  const handleCheckout = async (method: "cash" | "upi") => {
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethod: method }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Checkout failed");
      setReceipt(data.transaction);
      setShowCheckout(false);
      await Promise.all([fetchCart(), fetchTxns()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Checkout failed";
      setError(msg);
      setShowCheckout(false);
    }
  };

  return (
    <div className="pos">
      {/* ── Header ───────────────────────────────────── */}
      <header className="pos-header">
        <h1>PayNGo POS</h1>
        <div className={`status ${isLive ? "live" : ""}`}>
          <span className="dot" />
          {isLive ? "Live" : "Offline"}
        </div>
      </header>

      <div className="pos-body">
        {/* ── Cart panel ─────────────────────────────── */}
        <main className="pos-main">
          <div className="cart-panel">
            <div className="cart-header">
              <h2>Current Cart</h2>
              <span className="cart-count">
                {cart.totalCount} item{cart.totalCount !== 1 ? "s" : ""}
              </span>
            </div>

            {error ? (
              <div className="cart-empty">
                <p style={{ color: "var(--red)" }}>{error}</p>
              </div>
            ) : cart.items.length === 0 ? (
              <div className="cart-empty">
                <span className="icon">🛒</span>
                <p>Waiting for items…</p>
              </div>
            ) : (
              <div className="cart-items">
                {cart.items.map((it) => (
                  <div key={it.name} className="cart-item">
                    <div className={`cart-item-icon product-icon ${it.name}`}>
                      {PRODUCT_EMOJI[it.name] ?? "📦"}
                    </div>
                    <div className="cart-item-info">
                      <div className="cart-item-name">{it.label}</div>
                      <div className="cart-item-price">
                        {it.unitPrice != null
                          ? `${INR.format(it.unitPrice)} each`
                          : "price n/a"}
                      </div>
                    </div>
                    <div className="cart-item-right">
                      {it.lineTotal != null && (
                        <span className="cart-item-total">
                          {INR.format(it.lineTotal)}
                        </span>
                      )}
                      <span className="qty-badge">×{it.quantity}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="cart-footer">
              <div className="totals-row">
                <span className="label">Total</span>
                <span className="amount">{INR.format(cart.totalAmount)}</span>
              </div>
              <div className="btn-row">
                <button
                  className="btn btn-clear"
                  disabled={cart.items.length === 0}
                  onClick={async () => {
                    await fetch("/api/cart/clear", { method: "POST" });
                    await Promise.all([fetchCart(), fetchTxns()]);
                  }}
                >
                  Clear
                </button>
                <button
                  className="btn btn-checkout"
                  disabled={cart.items.length === 0}
                  onClick={() => setShowCheckout(true)}
                >
                  Checkout
                </button>
              </div>
            </div>
          </div>
        </main>

        {/* ── Transaction history sidebar ────────────── */}
        <aside className="pos-sidebar">
          <div className="sidebar-header">
            <h2>Recent Transactions</h2>
          </div>
          <div className="txn-list">
            {txns.length === 0 ? (
              <div className="txn-empty">No transactions yet</div>
            ) : (
              txns.map((txn) => (
                <div key={txn._id} className="txn-card">
                  <div className="txn-card-header">
                    <span className="txn-amount">{INR.format(txn.totalAmount)}</span>
                    <span className={`txn-method ${txn.paymentMethod}`}>
                      {txn.paymentMethod === "cash" ? "💵" : "📱"} {txn.paymentMethod}
                    </span>
                  </div>
                  <div className="txn-items">
                    {txn.items.map((it) => (
                      <div key={it.name} className="txn-item">
                        <span className="txn-item-name">{it.label}</span>
                        <span className="txn-item-qty">×{it.quantity}</span>
                      </div>
                    ))}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginTop: 8,
                      fontSize: 11,
                      color: "#64748b",
                    }}
                  >
                    <span>{txnDate(txn.ts)}</span>
                    <span>{txnTime(txn.ts)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      {/* ── Modals ──────────────────────────────────── */}
      {showCheckout && (
        <CheckoutModal
          items={cart.items}
          totalAmount={cart.totalAmount}
          totalCount={cart.totalCount}
          onConfirm={handleCheckout}
          onClose={() => setShowCheckout(false)}
        />
      )}
      {receipt && (
        <ReceiptModal txn={receipt} onClose={() => setReceipt(null)} />
      )}
    </div>
  );
}
