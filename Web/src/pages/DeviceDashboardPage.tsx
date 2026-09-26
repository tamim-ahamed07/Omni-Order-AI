import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  acceptStoreOrder,
  cancelStoreOrder,
  getDeviceBootstrap,
  getStoreOrder,
  getStoreOrderHistory,
  updateStoreOpenState,
  updateStoreOrderStatus,
} from "../lib/api";
import { formatCurrency, formatDateTime, formatPhoneDisplay, formatRelativeTime } from "../lib/format";
import { clearDeviceToken, getDeviceToken } from "../lib/storage";
import { usePendingAction } from "../lib/usePendingAction";
import type {
  DeviceBootstrapResponse,
  OrderDetail,
  OrderStatus,
  OrderStatusHistoryEntry,
  OrderSummary,
} from "../types";

const POLL_INTERVAL_MS = 15000;
const ALERT_REPEAT_MS = 4000;
const ALERT_STATUSES: OrderStatus[] = ["new", "queued_for_open"];

function getAlertableOrderIds(orders: OrderSummary[]): Set<string> {
  return new Set(orders.filter((o) => ALERT_STATUSES.includes(o.status)).map((o) => o.id));
}

function getPaidAlertableOrderIds(orders: OrderSummary[]): Set<string> {
  return new Set(orders.filter((o) => ALERT_STATUSES.includes(o.status) && o.paymentStatus === "paid").map((o) => o.id));
}

const ACTIVE_COLUMNS: Array<{ title: string; status: OrderStatus }> = [
  { title: "Queued", status: "queued_for_open" },
  { title: "New", status: "new" },
  { title: "Accepted", status: "accepted" },
  { title: "In progress", status: "in_progress" },
  { title: "Ready", status: "ready" },
];
const STATUS_LABELS: Record<OrderStatus, string> = {
  queued_for_open: "Queued for open",
  new: "New",
  accepted: "Accepted",
  in_progress: "In progress",
  ready: "Ready",
  completed: "Completed",
  cancelled: "Cancelled",
};

const CANCEL_REASONS = [
  "Out of stock",
  "Kitchen too busy",
  "Payment not received",
  "Store closing early",
  "Customer request",
  "Other",
] as const;

type CancelReason = typeof CANCEL_REASONS[number];

function formatOrderItemSelection(selection: {
  optionId: string;
  optionName?: string;
  choiceId: string;
  choiceName?: string;
}): string {
  if (selection.optionName && selection.choiceName) {
    return `${selection.optionName}: ${selection.choiceName}`;
  }

  return selection.choiceName || selection.choiceId || selection.optionId;
}

let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  const AudioContextClass =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) {
    return null;
  }
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new AudioContextClass();
  }
  return sharedAudioContext;
}

export function unlockAudioContext(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") {
    void ctx.resume();
  }
}

function playNewOrderAlert(): void {
  const audioContext = getAudioContext();
  if (!audioContext || audioContext.state !== "running") {
    return;
  }

  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 8;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.22;
  compressor.connect(audioContext.destination);

  const pattern = [
    { frequency: 880, offset: 0, duration: 0.18 },
    { frequency: 740, offset: 0.24, duration: 0.18 },
    { frequency: 988, offset: 0.48, duration: 0.24 },
  ];
  const startTime = audioContext.currentTime + 0.02;

  for (const note of pattern) {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    const noteStart = startTime + note.offset;
    const notePeak = noteStart + 0.02;
    const noteEnd = noteStart + note.duration;

    oscillator.connect(gainNode);
    gainNode.connect(compressor);
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(note.frequency, noteStart);
    gainNode.gain.setValueAtTime(0.0001, noteStart);
    gainNode.gain.exponentialRampToValueAtTime(0.14, notePeak);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
    oscillator.start(noteStart);
    oscillator.stop(noteEnd + 0.03);
  }
}

function getNextActions(status: OrderStatus): Array<{ label: string; nextStatus?: OrderStatus; variant: string; type: "accept" | "cancel" | "status" }> {
  switch (status) {
    case "queued_for_open":
      return [
        { label: "Accept order", type: "accept", variant: "success" },
        { label: "Cancel order", type: "cancel", variant: "danger" },
      ];
    case "new":
      return [
        { label: "Accept order", type: "accept", variant: "success" },
        { label: "Cancel order", type: "cancel", variant: "danger" },
      ];
    case "accepted":
      return [
        { label: "Start preparing", type: "status", nextStatus: "in_progress", variant: "primary" },
        { label: "Mark ready", type: "status", nextStatus: "ready", variant: "warning" },
        { label: "Cancel order", type: "cancel", variant: "danger" },
      ];
    case "in_progress":
      return [
        { label: "Mark ready", type: "status", nextStatus: "ready", variant: "warning" },
        { label: "Cancel order", type: "cancel", variant: "danger" },
      ];
    case "ready":
      return [
        { label: "Complete order", type: "status", nextStatus: "completed", variant: "success" },
      ];
    default:
      return [];
  }
}

function getPrimaryBoardAction(status: OrderStatus): ReturnType<typeof getNextActions>[number] | null {
  return getNextActions(status).find((action) => action.type !== "cancel") ?? null;
}

function isDocumentVisible(): boolean {
  return document.visibilityState === "visible";
}

type DashboardToolbarAction = "fullscreen" | "refresh" | "store-toggle";

export function DeviceDashboardPage() {
  const navigate = useNavigate();
  const [bootstrap, setBootstrap] = useState<DeviceBootstrapResponse | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedOrderHistory, setSelectedOrderHistory] = useState<OrderStatusHistoryEntry[]>([]);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(() => document.fullscreenElement !== null);
  const [isPageVisible, setIsPageVisible] = useState<boolean>(() => isDocumentVisible());
  const [cancelFlow, setCancelFlow] = useState<{ orderId: string; reason: CancelReason | null; note: string } | null>(null);
  const seenAlertableIdsRef = useRef<Set<string>>(new Set());
  const seenPaidAlertableIdsRef = useRef<Set<string>>(new Set());
  const firstLoadRef = useRef(true);
  const alertIntervalRef = useRef<number | null>(null);
  const latestSelectionRequestRef = useRef(0);
  const bootstrapRequestRef = useRef<Promise<void> | null>(null);
  const {
    isPending: isToolbarActionPending,
    startAction: startToolbarAction,
    finishAction: finishToolbarAction,
  } = usePendingAction<DashboardToolbarAction>();
  const {
    isPending: isOrderSelectionPending,
    startAction: startSelectingOrder,
    finishAction: finishSelectingOrder,
  } = usePendingAction<string>();
  const {
    isPending: isOrderActionPending,
    startAction: startOrderAction,
    finishAction: finishOrderAction,
  } = usePendingAction<string>();

  const deviceToken = getDeviceToken();

  useEffect(() => {
    const unlock = () => unlockAudioContext();
    window.addEventListener("click", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    window.addEventListener("touchstart", unlock, { once: true });
    return () => {
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
  }, []);

  const stopRepeatingNewOrderAlert = useCallback(() => {
    if (alertIntervalRef.current !== null) {
      window.clearInterval(alertIntervalRef.current);
      alertIntervalRef.current = null;
    }
  }, []);

  const startRepeatingNewOrderAlert = useCallback(() => {
    if (!isPageVisible) {
      return;
    }

    playNewOrderAlert();

    if (alertIntervalRef.current === null) {
      alertIntervalRef.current = window.setInterval(() => {
        playNewOrderAlert();
      }, ALERT_REPEAT_MS);
    }
  }, [isPageVisible]);

  const loadSelectedOrderDetails = useCallback(async (storeId: number, orderId: string, requestId?: number) => {
    const [detailResponse, historyResponse] = await Promise.all([
      getStoreOrder({
        storeId,
        orderId,
        deviceToken,
      }),
      getStoreOrderHistory({
        storeId,
        orderId,
        deviceToken,
      }),
    ]);

    if (requestId !== undefined && latestSelectionRequestRef.current !== requestId) {
      return;
    }

    setSelectedOrder(detailResponse.order);
    setSelectedOrderHistory(historyResponse.history);
    setSelectedOrderId(orderId);
  }, [deviceToken]);

  const loadBootstrap = useCallback(async (mode: "initial" | "poll" = "poll") => {
    if (mode === "poll" && !isDocumentVisible()) {
      return;
    }

    if (bootstrapRequestRef.current) {
      await bootstrapRequestRef.current;
      return;
    }

    if (!deviceToken) {
      navigate("/device/activate", { replace: true });
      return;
    }

    const runLoad = async () => {
      if (mode === "initial") {
        setLoading(true);
      } else {
        setSyncing(true);
      }

      try {
        const result = await getDeviceBootstrap(deviceToken);
        setBootstrap(result);
        setLastUpdated(new Date().toISOString());
        setErrorMessage("");

        const nextAlertableIds = getAlertableOrderIds(result.orders);
        const nextPaidAlertableIds = getPaidAlertableOrderIds(result.orders);

        if (firstLoadRef.current) {
          if (nextAlertableIds.size > 0) {
            startRepeatingNewOrderAlert();
          }
        } else {
          const hasNewOrder = Array.from(nextAlertableIds).some((id) => !seenAlertableIdsRef.current.has(id));
          const hasNewlyPaidOrder = Array.from(nextPaidAlertableIds).some((id) => !seenPaidAlertableIdsRef.current.has(id));
          if (hasNewOrder || hasNewlyPaidOrder) {
            startRepeatingNewOrderAlert();
          }
        }
        seenAlertableIdsRef.current = nextAlertableIds;
        seenPaidAlertableIdsRef.current = nextPaidAlertableIds;
        if (nextAlertableIds.size === 0) {
          stopRepeatingNewOrderAlert();
        }
        firstLoadRef.current = false;

        if (selectedOrderId) {
          const selectedOrderSummary = result.orders.find((order) => order.id === selectedOrderId);
          if (selectedOrderSummary) {
            const selectedOrderSummaryFields = {
              id: selectedOrderSummary.id,
              storeId: selectedOrderSummary.storeId,
              storeName: selectedOrderSummary.storeName,
              customerPhone: selectedOrderSummary.customerPhone,
              customerName: selectedOrderSummary.customerName,
              total: selectedOrderSummary.total,
              currency: selectedOrderSummary.currency,
              status: selectedOrderSummary.status,
              paymentStatus: selectedOrderSummary.paymentStatus,
              createdAt: selectedOrderSummary.createdAt,
              updatedAt: selectedOrderSummary.updatedAt,
            };
            setSelectedOrder((current) => {
              if (!current || current.id !== selectedOrderId) {
                return current;
              }

              return {
                ...current,
                ...selectedOrderSummaryFields,
              };
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load dashboard";
        setErrorMessage(message);
        if (message.toLowerCase().includes("device token")) {
          clearDeviceToken();
          navigate("/device/activate", { replace: true });
        }
      } finally {
        setLoading(false);
        setSyncing(false);
      }
    };

    const loadPromise = runLoad();
    bootstrapRequestRef.current = loadPromise;

    try {
      await loadPromise;
    } finally {
      if (bootstrapRequestRef.current === loadPromise) {
        bootstrapRequestRef.current = null;
      }
    }
  }, [deviceToken, navigate, selectedOrderId, startRepeatingNewOrderAlert, stopRepeatingNewOrderAlert]);

  const syncPageVisibility = useCallback((pageIsVisible: boolean) => {
    setIsPageVisible(pageIsVisible);
    if (!pageIsVisible) {
      stopRepeatingNewOrderAlert();
    }
  }, [stopRepeatingNewOrderAlert]);

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      void loadBootstrap("initial");
    }, 0);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [loadBootstrap]);

  useEffect(() => {
    function handleVisibilityChange() {
      const pageIsVisible = isDocumentVisible();
      syncPageVisibility(pageIsVisible);
      if (!pageIsVisible) {
        return;
      }

      void loadBootstrap("poll");
    }

    function handlePageHide() {
      syncPageVisibility(false);
    }

    function handlePageShow() {
      syncPageVisibility(true);
      void loadBootstrap("poll");
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [loadBootstrap, syncPageVisibility]);

  useEffect(() => {
    return () => {
      stopRepeatingNewOrderAlert();
      if (sharedAudioContext && sharedAudioContext.state !== "closed") {
        void sharedAudioContext.close();
        sharedAudioContext = null;
      }
    };
  }, [stopRepeatingNewOrderAlert]);

  useEffect(() => {
    if (!bootstrap) {
      return;
    }

    if (!isPageVisible) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (!isDocumentVisible()) {
        return;
      }

      void loadBootstrap("poll");
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [bootstrap, isPageVisible, loadBootstrap]);

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement !== null);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const ordersByStatus = useMemo(() => {
    const grouped = new Map<OrderStatus, OrderSummary[]>();
    if (!bootstrap) {
      return grouped;
    }

    for (const column of ACTIVE_COLUMNS) {
      grouped.set(
        column.status,
        bootstrap.orders.filter((order) => order.status === column.status),
      );
    }

    return grouped;
  }, [bootstrap]);

  const visibleColumns = useMemo(() => {
    const columnsWithOrders = ACTIVE_COLUMNS.filter((column) => (ordersByStatus.get(column.status) ?? []).length > 0);
    return columnsWithOrders.length > 0 ? columnsWithOrders : ACTIVE_COLUMNS;
  }, [ordersByStatus]);

  async function handleSelectOrder(orderId: string) {
    if (!bootstrap || !startSelectingOrder(orderId)) {
      return;
    }

    const requestId = latestSelectionRequestRef.current + 1;
    latestSelectionRequestRef.current = requestId;

    try {
      await loadSelectedOrderDetails(bootstrap.store.id, orderId, requestId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load order detail");
    } finally {
      finishSelectingOrder(orderId);
    }
  }

  async function handleStoreToggle() {
    if (!bootstrap || !startToolbarAction("store-toggle")) {
      return;
    }

    try {
      await updateStoreOpenState({
        storeId: bootstrap.store.id,
        isOpen: !bootstrap.store.settings.isOpen,
        deviceToken,
      });
      await loadBootstrap("poll");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update store status");
    } finally {
      finishToolbarAction("store-toggle");
    }
  }

  async function handleOrderAction(orderId: string, action: ReturnType<typeof getNextActions>[number]) {
    if (!bootstrap || !startOrderAction(orderId)) {
      return;
    }

    try {
      if (action.type === "accept") {
        await acceptStoreOrder({
          storeId: bootstrap.store.id,
          orderId,
          deviceToken,
        });
      } else if (action.type === "cancel") {
        finishOrderAction(orderId);
        setCancelFlow({ orderId, reason: null, note: "" });
        return;
      } else if (action.nextStatus) {
        await updateStoreOrderStatus({
          storeId: bootstrap.store.id,
          orderId,
          status: action.nextStatus,
          deviceToken,
        });
      }

      if (action.type === "accept") {
        seenAlertableIdsRef.current = new Set([...seenAlertableIdsRef.current].filter((id) => id !== orderId));
        seenPaidAlertableIdsRef.current = new Set([...seenPaidAlertableIdsRef.current].filter((id) => id !== orderId));
        if (seenAlertableIdsRef.current.size === 0) {
          stopRepeatingNewOrderAlert();
        }
      }

      await loadBootstrap("poll");
      if (selectedOrderId === orderId) {
        await loadSelectedOrderDetails(bootstrap.store.id, orderId);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update order");
    } finally {
      finishOrderAction(orderId);
    }
  }

  async function handleConfirmCancel() {
    if (!bootstrap || !cancelFlow || !cancelFlow.reason) {
      return;
    }

    const { orderId, reason, note } = cancelFlow;

    if (!startOrderAction(orderId)) {
      return;
    }

    try {
      await cancelStoreOrder({
        storeId: bootstrap.store.id,
        orderId,
        deviceToken,
        reason,
        note: note.trim() || undefined,
      });

      setCancelFlow(null);
      seenAlertableIdsRef.current = new Set([...seenAlertableIdsRef.current].filter((id) => id !== orderId));
      seenPaidAlertableIdsRef.current = new Set([...seenPaidAlertableIdsRef.current].filter((id) => id !== orderId));
      if (seenAlertableIdsRef.current.size === 0) {
        stopRepeatingNewOrderAlert();
      }

      await loadBootstrap("poll");
      if (selectedOrderId === orderId) {
        await loadSelectedOrderDetails(bootstrap.store.id, orderId);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to cancel order");
    } finally {
      finishOrderAction(orderId);
    }
  }

  function handleAbortCancel() {
    setCancelFlow(null);
  }

  function handleSignOut() {
    clearDeviceToken();
    navigate("/device/activate", { replace: true });
  }

  function handleCloseOrder() {
    setSelectedOrderId(null);
    setSelectedOrder(null);
    setSelectedOrderHistory([]);
    setCancelFlow(null);
  }

  async function handleToggleFullscreen() {
    if (!startToolbarAction("fullscreen")) {
      return;
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }

      await document.documentElement.requestFullscreen();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to change fullscreen mode");
    } finally {
      finishToolbarAction("fullscreen");
    }
  }

  async function handleRefreshDashboard() {
    if (!startToolbarAction("refresh")) {
      return;
    }

    try {
      await loadBootstrap("poll");
    } finally {
      finishToolbarAction("refresh");
    }
  }

  if (loading && !bootstrap) {
    return (
      <section className="dashboard-empty-state">
        <div className="empty-state">
          <h2>Opening service board</h2>
          <p>Connecting this device to the restaurant workspace...</p>
        </div>
      </section>
    );
  }

  if (!bootstrap) {
    return (
      <section className="dashboard-empty-state">
        <div className="empty-state">
          <h2>Service board unavailable</h2>
          <p>{errorMessage || "This device is not connected yet."}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="ops-dashboard">
      <section className="ops-header ops-header-compact">
        <div className="ops-header-main">
          <div className="ops-header-title">
            <div>
              <p className="eyebrow">Live service board</p>
              <h2>{bootstrap.store.name}</h2>
            </div>
            <div className="ops-header-strip">
              <span className={`status-chip ${bootstrap.store.settings.isOpen ? "paid" : "cancelled"}`}>
                {bootstrap.store.settings.isOpen ? "Open for orders" : "Paused"}
              </span>
              <span className="meta-pill">{bootstrap.orders.length} live orders</span>
              {!bootstrap.store.settings.showUnpaidOrders ? (
                <span className="meta-pill">Paid orders only</span>
              ) : null}
            </div>
          </div>

          <div className="ops-header-actions">
            <div className="button-row ops-header-buttons">
              <button
                type="button"
                className="button ghost toggle-button"
                onClick={() => void handleStoreToggle()}
                disabled={isToolbarActionPending("store-toggle")}
              >
                {bootstrap.store.settings.isOpen ? "Pause new orders" : "Resume orders"}
              </button>
              <button
                type="button"
                className="button ghost"
                onClick={() => void handleToggleFullscreen()}
                disabled={isToolbarActionPending("fullscreen")}
              >
                {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              </button>
              <button
                type="button"
                className="button ghost"
                onClick={() => void handleRefreshDashboard()}
                disabled={syncing || isToolbarActionPending("refresh")}
              >
                {syncing ? "Checking..." : "Check now"}
              </button>
              <button type="button" className="button subtle" onClick={handleSignOut}>
                Reset device
              </button>
            </div>
            <p className="field-hint ops-subtitle ops-subtitle-compact">
              Device <span className="mono">{bootstrap.device.name}</span> ·{" "}
              {syncing ? "Checking for updates..." : `Last checked ${lastUpdated ? formatDateTime(lastUpdated) : "just now"}`}
            </p>
          </div>
        </div>

        {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
      </section>

      <section className="ops-board">
        <div className="section-heading section-heading-compact">
          <div className="ops-board-heading">
            <h3>Order lanes</h3>
            <p className="field-hint">
              {visibleColumns.length < ACTIVE_COLUMNS.length
                ? "Showing active lanes only."
                : "Swipe horizontally to see more lanes."}
            </p>
          </div>
        </div>

        {bootstrap.orders.length === 0 ? (
          <div className="empty-state board-empty-state">
            <h2>No live orders</h2>
            <p>New tickets will appear here as soon as customers place them.</p>
          </div>
        ) : (
        <div className="dashboard-grid-scroll">
        <div className="dashboard-grid">
          {visibleColumns.map((column) => {
            const columnOrders = ordersByStatus.get(column.status) ?? [];

            return (
              <section className="board-column" key={column.status}>
                <div className="lane-header">
                  <div>
                    <h3>{column.title}</h3>
                    <p className="column-subtitle">{columnOrders.length} orders</p>
                  </div>
                </div>

                {columnOrders.length === 0 ? (
                  <div className="empty-state lane-empty-state">
                    <p>No orders here right now.</p>
                  </div>
                ) : (
                  columnOrders.map((order) => {
                    const primaryAction = getPrimaryBoardAction(order.status);
                    const isOrderBusy = isOrderSelectionPending(order.id) || isOrderActionPending(order.id);

                    return (
                      <article
                        className={selectedOrderId === order.id ? "order-card order-card-selected" : "order-card"}
                        key={order.id}
                      >
                        <button
                          type="button"
                          className="order-card-main"
                          onClick={() => void handleSelectOrder(order.id)}
                          disabled={isOrderBusy}
                        >
                          <div className="order-card-topline">
                            <h3>{order.customerName || formatPhoneDisplay(order.customerPhone)}</h3>
                            <strong className="order-total">{formatCurrency(order.total, order.currency)}</strong>
                          </div>
                          <div className="order-card-meta">
                            <span>{order.itemCount} items</span>
                            <span>{formatRelativeTime(order.createdAt)}</span>
                          </div>
                          {order.paymentStatus === "unpaid" ? (
                            <div className="order-card-flags">
                              <span className="status-chip unpaid">Unpaid</span>
                            </div>
                          ) : null}
                        </button>

                        <div className="order-actions order-actions-compact">
                          <button
                            type="button"
                            className="button ghost"
                            onClick={() => void handleSelectOrder(order.id)}
                            disabled={isOrderBusy}
                          >
                            View
                          </button>
                          {primaryAction ? (
                            <button
                              type="button"
                              className={`button ${primaryAction.variant}`}
                              onClick={() => void handleOrderAction(order.id, primaryAction)}
                              disabled={isOrderBusy}
                            >
                              {primaryAction.label}
                            </button>
                          ) : null}
                        </div>
                      </article>
                    );
                  })
                )}
              </section>
            );
          })}
        </div>
        </div>
        )}
      </section>

      {selectedOrder ? (
        <>
          <button type="button" className="drawer-backdrop" aria-label="Close order details" onClick={handleCloseOrder} />
          <aside className="ops-drawer panel stack">
            <div className="ops-drawer-header">
              <div>
                <p className="eyebrow">Order details</p>
                <h3>{selectedOrder.customerName || formatPhoneDisplay(selectedOrder.customerPhone)}</h3>
                <p className="field-hint mono">{selectedOrder.id}</p>
              </div>
              <button type="button" className="drawer-close-button" aria-label="Close order details" onClick={handleCloseOrder}>
                X
              </button>
            </div>

            <section className="detail-card">
              <div className="detail-summary-row">
                <span className={`status-chip ${selectedOrder.status}`}>{STATUS_LABELS[selectedOrder.status]}</span>
                {selectedOrder.paymentStatus === "unpaid" ? (
                  <span className="status-chip unpaid">Unpaid</span>
                ) : null}
              </div>

              <div className="detail-stats detail-stats-compact">
                <article className="stat-card">
                  <span className="stat-label">Total</span>
                  <strong>{formatCurrency(selectedOrder.total, selectedOrder.currency)}</strong>
                </article>
                <article className="stat-card">
                  <span className="stat-label">Items</span>
                  <strong>{selectedOrder.items.length}</strong>
                </article>
                <article className="stat-card">
                  <span className="stat-label">Received</span>
                  <strong>{formatRelativeTime(selectedOrder.createdAt)}</strong>
                </article>
              </div>

              <div className="detail-meta-list">
                <span className="meta-pill">Created {formatDateTime(selectedOrder.createdAt)}</span>
                <span className="meta-pill">Updated {formatDateTime(selectedOrder.updatedAt)}</span>
              </div>
            </section>

            <section className="detail-card">
              <div className="section-heading">
                <div>
                  <h4>Items</h4>
                </div>
              </div>
              <div className="detail-line-list">
                {selectedOrder.items.map((item) => (
                  <div key={`${selectedOrder.id}-${item.itemId}-${item.itemName}`} className="detail-line-item">
                    <div>
                      <strong>
                        {item.quantity} × {item.itemName}
                      </strong>
                      {item.selectedOptions.length > 0 ? (
                        <div className="field-hint">
                          {item.selectedOptions.map((selection) => (
                            <div key={`${item.itemId}-${selection.optionId}-${selection.choiceId}`}>
                              {formatOrderItemSelection(selection)}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <p className="field-hint">{formatCurrency(item.price, selectedOrder.currency)} each</p>
                    </div>
                    <strong>{formatCurrency(item.price * item.quantity, selectedOrder.currency)}</strong>
                  </div>
                ))}
              </div>
            </section>

            <section className="detail-card">
              <div className="section-heading">
                <div>
                  <h4>Service history</h4>
                </div>
              </div>

              {selectedOrderHistory.length === 0 ? (
                <p className="field-hint">No updates yet.</p>
              ) : (
                <div className="timeline">
                  {selectedOrderHistory.map((entry) => (
                    <div key={entry.id} className="timeline-item">
                      <div className="timeline-dot" aria-hidden="true" />
                      <div className="timeline-content">
                        <div className="order-card-header">
                          <span className={`status-chip ${entry.status}`}>{STATUS_LABELS[entry.status]}</span>
                          <span className="field-hint">{formatDateTime(entry.changedAt)}</span>
                        </div>
                        <p className="field-hint">{entry.note || "Updated without an additional note."}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {cancelFlow?.orderId === selectedOrder.id ? (
              <div className="cancel-confirm ops-drawer-actions">
                <p className="cancel-confirm-label">Select a reason to cancel:</p>
                <div className="cancel-reason-chips">
                  {CANCEL_REASONS.map((r) => (
                    <button
                      type="button"
                      key={r}
                      className={`cancel-reason-chip${cancelFlow.reason === r ? " selected" : ""}`}
                      onClick={() => setCancelFlow((prev) => prev ? { ...prev, reason: r } : prev)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                {cancelFlow.reason === "Other" && (
                  <textarea
                    className="cancel-note-field"
                    placeholder="Describe the reason (optional)"
                    maxLength={500}
                    rows={2}
                    value={cancelFlow.note}
                    onChange={(e) => setCancelFlow((prev) => prev ? { ...prev, note: e.target.value } : prev)}
                  />
                )}
                <div className="cancel-confirm-actions">
                  <button type="button" className="button secondary" onClick={handleAbortCancel}>
                    ← Go back
                  </button>
                  <button
                    type="button"
                    className="button danger"
                    disabled={!cancelFlow.reason || isOrderActionPending(selectedOrder.id)}
                    onClick={() => void handleConfirmCancel()}
                  >
                    Confirm cancellation
                  </button>
                </div>
              </div>
            ) : (
              <div className="ops-drawer-actions">
                {selectedOrder.status === "cancelled" && selectedOrder.customerPhone ? (
                  <div className="cancel-contact-callout">
                    <span className="cancel-contact-label">Consider reaching out to the customer:</span>
                    <a href={`tel:${selectedOrder.customerPhone}`} className="cancel-contact-phone">
                      📞 {formatPhoneDisplay(selectedOrder.customerPhone)}
                    </a>
                  </div>
                ) : (
                  getNextActions(selectedOrder.status).map((action) => (
                    <button
                      type="button"
                      key={`${selectedOrder.id}-${action.label}`}
                      className={`button ${action.variant}`}
                      onClick={() => void handleOrderAction(selectedOrder.id, action)}
                      disabled={isOrderActionPending(selectedOrder.id)}
                    >
                      {action.label}
                    </button>
                  ))
                )}
              </div>
            )}
          </aside>
        </>
      ) : null}
    </section>
  );
}
