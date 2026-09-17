"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

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
  paymentMethod: string;
  paymentStatus: string;
  ts: string;
}

type Method = "cash" | "upi" | "card";

/** Declared by the Razorpay checkout.js script when loaded. */
declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => {
      open: () => void;
      on?: (event: string, cb: () => void) => void;
    };
  }
}

function loadRazorpayScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const src = "https://checkout.razorpay.com/v1/checkout.js";
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error("Could not load the payment gateway. Check your connection."));
    document.head.appendChild(script);
  });
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

export default function CheckoutPage() {
  const router = useRouter();
  const [cart, setCart] = useState<CartState | null>(null);
  const [method, setMethod] = useState<Method>("cash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Transaction | null>(null);
  const paymentOpenRef = useRef(false);

  // Auth check + load the cart.
  useEffect(() => {
    (async () => {
      try {
        const meRes = await fetch("/api/auth/me");
        const me = await meRes.json();
        if (!me.user) {
          router.replace("/login");
          return;
        }
        const cartRes = await fetch("/api/cart");
        if (!cartRes.ok) throw new Error("Cart unavailable");
        const data: CartState = await cartRes.json();
        setCart(data);
        if (data.items.length === 0) {
          // Nothing to pay — send the cashier back to the store.
          router.replace("/");
        }
      } catch {
        setError("Could not load your cart.");
      }
    })();
  }, [router]);

  const payOffline = async (m: "cash" | "upi") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethod: m }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Checkout failed");
      setReceipt(data.transaction);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Checkout failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const payCard = async () => {
    setBusy(true);
    setError(null);
    try {
      await loadRazorpayScript();

      const orderRes = await fetch("/api/payments/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const orderData = await orderRes.json();
      if (!orderRes.ok) throw new Error(orderData.error || "Could not initialize payment.");

      paymentOpenRef.current = true;

      const options = {
        key: orderData.key,
        amount: orderData.order.amount,
        currency: orderData.order.currency,
        name: "PayNGo",
        description: "Smart shelf checkout",
        order_id: orderData.order.id,
        prefill: { contact: "", email: "" },
        theme: { color: "#16a34a" },
        modal: {
          ondismiss: () => {
            paymentOpenRef.current = false;
            setBusy(false);
          },
        },
        handler: async (response: {
          razorpay_order_id: string;
          razorpay_payment_id: string;
          razorpay_signature: string;
        }) => {
          paymentOpenRef.current = false;
          try {
            const verifyRes = await fetch("/api/payments/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(response),
            });
            const verifyData = await verifyRes.json();
            if (!verifyRes.ok) throw new Error(verifyData.error || "Payment was not verified.");
            setReceipt(verifyData.transaction);
          } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Payment verification failed.");
          } finally {
            setBusy(false);
          }
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err: unknown) {
      paymentOpenRef.current = false;
      setBusy(false);
      const msg = err instanceof Error ? err.message : "Could not start payment.";
      if (msg.toLowerCase().includes("razorpay credentials") || msg.toLowerCase().includes("not configured")) {
        setError("Online card payments are not configured. Use Cash or UPI, or add Razorpay keys to .env.local.");
      } else {
        setError(msg);
      }
    }
  };

  const confirm = useCallback(() => {
    if (method === "card") {
      payCard();
    } else {
      payOffline(method);
    }
  }, [method]);

  if (receipt) {
    return (
      <div className="checkout-shell">
        <div className="checkout-card receipt" style={{ textAlign: "center" }}>
          <div className="checkmark">✓</div>
          <h3 style={{ marginBottom: 2 }}>Payment Received</h3>
          <p className="receipt-id">#{receipt._id.slice(-8).toUpperCase()}</p>

          <div className="receipt-items">
            {receipt.items.map((it) => (
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
              <span>{INR.format(receipt.totalAmount)}</span>
            </div>
          </div>

          <div className="receipt-meta">
            {receipt.paymentMethod.toUpperCase()} · {receipt.paymentStatus.toUpperCase()} ·{" "}
            {txnTime(receipt.ts)} · {txnDate(receipt.ts)}
          </div>

          <button
            className="btn btn-confirm"
            style={{ maxWidth: 220, margin: "0 auto" }}
            onClick={() => router.push("/")}
          >
            Back to store
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="checkout-shell">
      <div className="checkout-card">
        <button
          className="header-btn"
          style={{ marginBottom: 14 }}
          onClick={() => router.push("/")}
        >
          ← Back to store
        </button>

        <h2>Checkout</h2>
        <p className="checkout-sub">
          {cart?.totalCount ?? 0} item{(cart?.totalCount ?? 0) !== 1 ? "s" : ""} in cart
        </p>

        <div className="checkout-items">
          {(cart?.items ?? []).map((it) => (
            <div key={it.name} className="checkout-item">
              <span className="checkout-item-name">{it.label}</span>
              <span className="checkout-item-detail">
                {it.quantity} × {it.unitPrice != null ? INR.format(it.unitPrice) : "—"}
                {it.lineTotal != null ? ` = ${INR.format(it.lineTotal)}` : ""}
              </span>
            </div>
          ))}
        </div>

        <div className="checkout-total">
          <span className="label">Total</span>
          <span className="amount">{INR.format(cart?.totalAmount ?? 0)}</span>
        </div>

        <div className="method-label">Payment method</div>
        <div className="modal-pay-methods">
          <button
            className={`pay-btn ${method === "cash" ? "selected" : ""}`}
            onClick={() => setMethod("cash")}
            disabled={busy}
          >
            💵 Cash
          </button>
          <button
            className={`pay-btn ${method === "upi" ? "selected" : ""}`}
            onClick={() => setMethod("upi")}
            disabled={busy}
          >
            📱 UPI
          </button>
          <button
            className={`pay-btn ${method === "card" ? "selected" : ""}`}
            onClick={() => setMethod("card")}
            disabled={busy}
          >
            💳 Card
          </button>
        </div>

        {error && <div className="checkout-error">{error}</div>}

        <div className="checkout-actions">
          <button
            className="btn btn-confirm"
            disabled={busy || (cart?.items.length ?? 0) === 0}
            onClick={confirm}
          >
            {busy ? "Processing…" : method === "card" ? "Pay Online" : `Pay ${INR.format(cart?.totalAmount ?? 0)}`}
          </button>
        </div>

        <p className="checkout-note">
          Cash and UPI are recorded as paid on the spot. Card payments go through Razorpay.
        </p>
      </div>
    </div>
  );
}