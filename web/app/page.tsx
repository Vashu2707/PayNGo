"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface CartItem {
  name: string;
  quantity: number;
}

interface CartEvent {
  type: "pick" | "place";
  product: string;
  ts: string;
}

const POLL_MS = 1500;
const LIVE_MS = 6000;

export default function Home() {
  const [items, setItems] = useState<CartItem[]>([]);
  const [events, setEvents] = useState<CartEvent[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const prevItemsRef = useRef<string>("");

  const fetchCart = useCallback(async () => {
    try {
      const res = await fetch("/api/cart", { cache: "no-store" });
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      setItems(data.items ?? []);
      setUpdatedAt(data.updatedAt ?? null);
      setError(null);
    } catch {
      setError("Cannot reach the cart. Check that MongoDB is configured.");
    }
  }, []);

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch("/api/events", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setEvents(data.events ?? []);
      }
    } catch {
      /* events are optional */
    }
  }, []);

  useEffect(() => {
    fetchCart();
    fetchEvents();
    const id = setInterval(() => {
      fetchCart();
      fetchEvents();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [fetchCart, fetchEvents]);

  useEffect(() => {
    const key = JSON.stringify(items);
    if (prevItemsRef.current && key !== prevItemsRef.current) {
      fetchEvents();
    }
    prevItemsRef.current = key;
  }, [items, fetchEvents]);

  const isLive =
    updatedAt !== null && Date.now() - new Date(updatedAt).getTime() < LIVE_MS;

  const total = items.reduce((sum, i) => sum + i.quantity, 0);

  const clear = async () => {
    setClearing(true);
    try {
      const res = await fetch("/api/cart/clear", { method: "POST" });
      if (!res.ok) throw new Error("failed");
      await fetchCart();
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="page">
      <div className="card">
        <div className="header">
          <h1>PayNGo</h1>
          <span className={`status${isLive ? " live" : ""}`}>
            <span className="dot" />
            {isLive ? "Live" : "Offline"}
          </span>
        </div>

        {error ? (
          <div className="empty">
            <div className="big">⚠️</div>
            <p>{error}</p>
          </div>
        ) : (
          <>
            <div className="count-line">
              <span className="label">Items in cart</span>
              <span className="total">{total}</span>
            </div>

            {items.length === 0 ? (
              <div className="empty">
                <div className="big">🛒</div>
                <p>Cart is empty — pick a product off the shelf to start.</p>
              </div>
            ) : (
              <ul className="item-list">
                {items.map((i) => (
                  <li key={i.name} className="item">
                    <span className="name">{i.name.replace(/-/g, " ")}</span>
                    <span className="qty">x{i.quantity}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="actions">
              <button
                className="btn primary"
                onClick={clear}
                disabled={clearing || items.length === 0}
              >
                Clear cart
              </button>
              <button className="btn secondary" onClick={fetchCart}>
                Refresh
              </button>
            </div>
          </>
        )}

        {events.length > 0 && (
          <div className="events">
            <h3>Recent activity</h3>
            {events.map((e, idx) => (
              <div key={idx} className="event-row">
                <span className={`tag ${e.type}`}>
                  {e.type === "pick" ? "Picked" : "Placed"}
                </span>
                <span>{e.product.replace(/-/g, " ")}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="footer">Smart Shelf · single-user cart</div>
    </div>
  );
}
