import { z } from "zod";
import { QUEUE_NOTIFICATIONS } from "../config/constants";
import { getStoreInfoById, updateStoreOperations } from "../shared/catalogStore";
import { enqueue } from "../shared/queueClient";
import {
    getErrorDetails,
    getOrderStatusHistory,
    getOrderById,
    listOrderSummariesByStore,
    OrderRecord,
    OrderStatus,
    OrderStatusHistoryRecord,
    OrderSummaryRecord,
    ORDER_STATUSES,
    updateOrderStatus,
} from "../shared/sqlClient";
import { StoreWithMenu } from "../shared/defaultCatalog";
import { createOrderStatusNotificationInput } from "./notificationService";

export const activeDashboardOrderStatuses: OrderStatus[] = [
    "new",
    "queued_for_open",
    "accepted",
    "in_progress",
    "ready",
];

export const orderStatusSchema = z.enum(ORDER_STATUSES);

export const updateOrderStatusRequestSchema = z.object({
    status: orderStatusSchema,
    note: z.string().trim().max(500).optional(),
});

export const updateStoreOperationsRequestSchema = z.object({
    isOpen: z.boolean(),
});

const allowedStatusTransitions: Record<OrderStatus, OrderStatus[]> = {
    new: ["accepted", "cancelled"],
    queued_for_open: ["accepted", "cancelled"],
    accepted: ["in_progress", "ready", "cancelled"],
    in_progress: ["ready", "cancelled"],
    ready: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
};

function isOrderVisibleOnDashboard(store: StoreWithMenu, paymentStatus: OrderRecord["paymentStatus"]): boolean {
    if (store.settings.showUnpaidOrders) {
        return true;
    }

    return paymentStatus === "paid";
}

function filterVisibleOrders(store: StoreWithMenu, orders: OrderSummaryRecord[]): OrderSummaryRecord[] {
    return orders.filter((order) => isOrderVisibleOnDashboard(store, order.paymentStatus));
}

function assertValidStatusTransition(currentStatus: OrderStatus, nextStatus: OrderStatus): void {
    if (currentStatus === nextStatus) {
        return;
    }

    if (!allowedStatusTransitions[currentStatus].includes(nextStatus)) {
        throw new Error(`Invalid order status transition: ${currentStatus} -> ${nextStatus}`);
    }
}

export async function getStoreOperationsContext(storeId: number): Promise<StoreWithMenu | null> {
    return await getStoreInfoById(storeId);
}

export async function listStoreDashboardOrders(input: {
    storeId: number;
    statuses?: OrderStatus[];
}): Promise<{ store: StoreWithMenu; orders: OrderSummaryRecord[] } | null> {
    const store = await getStoreInfoById(input.storeId);
    if (!store) {
        return null;
    }

    const orders = await listOrderSummariesByStore(input.storeId, input.statuses);

    return {
        store,
        orders: filterVisibleOrders(store, orders),
    };
}

export async function getStoreDashboardOrder(input: {
    storeId: number;
    orderId: string;
}): Promise<{ store: StoreWithMenu; order: OrderRecord } | null> {
    const store = await getStoreInfoById(input.storeId);
    if (!store) {
        return null;
    }

    const order = await getOrderById(input.orderId);
    if (!order || order.storeId !== input.storeId) {
        return null;
    }

    if (!isOrderVisibleOnDashboard(store, order.paymentStatus)) {
        return null;
    }

    return { store, order };
}

export async function changeStoreOrderStatus(input: {
    storeId: number;
    orderId: string;
    nextStatus: OrderStatus;
    note?: string;
    cancellationReason?: string;
}): Promise<{ order: OrderRecord; statusChanged: boolean; customerNotificationQueued: boolean } | null> {
    const orderContext = await getStoreDashboardOrder({
        storeId: input.storeId,
        orderId: input.orderId,
    });

    if (!orderContext) {
        return null;
    }

    assertValidStatusTransition(orderContext.order.status, input.nextStatus);
    const notification = createOrderStatusNotificationInput({
        orderId: input.orderId,
        status: input.nextStatus,
        storeName: orderContext.order.storeName,
        fulfillmentType: orderContext.order.fulfillmentType,
        channel: orderContext.order.channel,
        channelIdentifier: orderContext.order.channelIdentifier,
        customerPhone: orderContext.order.customerPhone,
        cancellationReason: input.cancellationReason,
    });
    const updateResult = await updateOrderStatus(input.orderId, input.nextStatus, {
        note: input.note,
        notification: notification ?? undefined,
    });

    let customerNotificationQueued = false;
    if (updateResult.notificationId !== null) {
        try {
            await enqueue(QUEUE_NOTIFICATIONS, {
                notificationId: updateResult.notificationId,
            });
            customerNotificationQueued = true;
        } catch (error) {
            console.error("[storeOperationsService] Failed to enqueue notification", {
                orderId: input.orderId,
                notificationId: updateResult.notificationId,
                error: getErrorDetails(error),
            });
        }
    }

    const updatedOrder = await getOrderById(input.orderId);
    if (!updatedOrder) {
        return null;
    }

    return {
        order: updatedOrder,
        statusChanged: updateResult.changed,
        customerNotificationQueued,
    };
}

export async function getStoreDashboardOrderHistory(input: {
    storeId: number;
    orderId: string;
}): Promise<{ store: StoreWithMenu; history: OrderStatusHistoryRecord[] } | null> {
    const orderContext = await getStoreDashboardOrder(input);
    if (!orderContext) {
        return null;
    }

    return {
        store: orderContext.store,
        history: await getOrderStatusHistory(input.orderId),
    };
}

export async function setStoreOpenState(input: {
    storeId: number;
    isOpen: boolean;
}): Promise<StoreWithMenu | null> {
    return await updateStoreOperations(input.storeId, { isOpen: input.isOpen });
}
