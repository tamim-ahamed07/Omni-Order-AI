import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { fetchPublicOrderStatus } from "../lib/api";
import { formatCurrency } from "../lib/format";
import { clearPendingCheckout, clearStorefrontCart } from "../lib/storage";
import type { PublicOrderStatusResponse } from "../types";

const POLL_INTERVAL_MS = 20000;
const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

export function OrderSuccessPage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const orderId = searchParams.get("orderId");
  const statusToken = searchParams.get("statusToken");

  const [order, setOrder] = useState<PublicOrderStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (slug) {
      clearPendingCheckout(slug);
      clearStorefrontCart(slug);
    }
  }, [slug]);

  useEffect(() => {
    if (!orderId || !statusToken) {
      setError("Missing order details. Please contact the store.");
      return;
    }

    async function load() {
      try {
        const data = await fetchPublicOrderStatus(orderId!, statusToken!);
        setOrder(data);
        if (TERMINAL_STATUSES.has(data.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        setError("Could not load order status. Your payment was received — please contact the store if you need help.");
      }
    }

    void load();
    pollRef.current = setInterval(() => { void load(); }, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [orderId, statusToken]);

  if (error) {
    return (
      <div className="storefront-success-page">
        <div className="panel storefront-success-card">
          <h1>Payment received</h1>
          <p className="storefront-success-note">{error}</p>
          {slug ? <Link to={`/stores/${slug}/order`} className="button secondary">Back to store</Link> : null}
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="storefront-success-page">
        <div className="panel storefront-success-card">
          <p className="field-hint">Loading order…</p>
        </div>
      </div>
    );
  }

  const isPaid = order.paymentStatus === "paid";
  const isTerminal = TERMINAL_STATUSES.has(order.status);

  return (
    <div className="storefront-success-page">
      <div className="panel storefront-success-card">
        <div className="storefront-success-header">
          <h1>{isPaid ? "Payment confirmed" : "Waiting for payment…"}</h1>
          <p className="field-hint">{order.storeName}</p>
        </div>

        <div className="storefront-success-status-row">
          <span className={`order-status-badge order-status-${order.status}`}>
            {statusLabel(order.status)}
          </span>
          {!isTerminal && !isPaid ? (
            <span className="storefront-success-polling-note">Updating automatically…</span>
          ) : null}
        </div>

        <table className="storefront-success-items">
          <tbody>
            {order.items.map((item, i) => (
              <tr key={i}>
                <td className="storefront-success-item-qty">{item.quantity}×</td>
                <td className="storefront-success-item-name">
                  {item.itemName}
                  {item.selectedOptions.length > 0 ? (
                    <span className="field-hint">
                      {" "}({item.selectedOptions.map((o) => o.choiceName ?? o.choiceId).join(", ")})
                    </span>
                  ) : null}
                </td>
                <td className="storefront-success-item-price">
                  {formatCurrency(item.price * item.quantity, order.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="storefront-success-totals">
          {order.subtotal !== order.total ? (
            <>
              <div className="storefront-success-total-row">
                <span>Subtotal</span>
                <span>{formatCurrency(order.subtotal, order.currency)}</span>
              </div>
              {order.feeTotal + order.tax > 0 ? (
                <div className="storefront-success-total-row">
                  <span>Tax &amp; fees</span>
                  <span>{formatCurrency(order.feeTotal + order.tax, order.currency)}</span>
                </div>
              ) : null}
            </>
          ) : null}
          <div className="storefront-success-total-row storefront-success-grand-total">
            <span>Total</span>
            <span>{formatCurrency(order.total, order.currency)}</span>
          </div>
        </div>

        {order.history.length > 0 ? (
          <div className="storefront-success-history">
            <p className="eyebrow">Order history</p>
            <ul>
              {order.history
                .filter((entry, index, arr) => arr.findIndex((e) => e.status === entry.status) === index)
                .map((entry) => (
                  <li key={entry.id} className="storefront-success-history-entry">
                    <span className={`order-status-badge order-status-${entry.status}`}>{statusLabel(entry.status)}</span>
                    {entry.status === "cancelled" && entry.note ? <span className="field-hint"> — {entry.note}</span> : null}
                  </li>
                ))}
            </ul>
          </div>
        ) : null}

        {slug ? (
          <Link to={`/stores/${slug}/order`} className="button secondary storefront-success-back">
            Back to store
          </Link>
        ) : null}
      </div>
    </div>
  );
}
