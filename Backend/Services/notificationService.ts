import { z } from "zod";
import {
    CreateNotificationInput,
    FULFILLMENT_TYPES,
    FulfillmentType,
    NotificationRecord,
    NotificationType,
    ORDER_STATUSES,
    OrderStatus,
} from "../shared/sqlClient";

type NotificationPayload = Record<string, unknown>;

export interface NotificationHandler<TPayload extends NotificationPayload = NotificationPayload> {
    type: NotificationType;
    payloadSchema: z.ZodType<TPayload>;
    buildMessage(payload: TPayload, notification: NotificationRecord): string | null;
}

const orderReadyPayloadSchema = z.object({
    orderId: z.string().min(1),
    storeName: z.string().min(1),
    fulfillmentType: z.enum(FULFILLMENT_TYPES).default("pickup"),
});

const orderCancelledPayloadSchema = z.object({
    orderId: z.string().min(1),
    storeName: z.string().min(1),
    reason: z.string().min(1),
});

const paymentReceivedPayloadSchema = z.object({
    orderId: z.string().min(1),
    storeName: z.string().min(1),
    total: z.number().finite(),
    orderStatus: z.enum(ORDER_STATUSES),
});

const ORDER_STATUS_NOTIFICATION_TYPES: Partial<Record<OrderStatus, NotificationType>> = {
    ready: "order_ready",
    cancelled: "order_cancelled",
};

function defineNotificationHandler<TPayload extends NotificationPayload>(
    handler: NotificationHandler<TPayload>
): NotificationHandler<TPayload> {
    return handler;
}

const orderReadyNotificationHandler = defineNotificationHandler({
    type: "order_ready",
    payloadSchema: orderReadyPayloadSchema,
    buildMessage: (payload) => [
        `Your order ${payload.orderId} from ${payload.storeName} is ready.`,
        payload.fulfillmentType === "delivery"
            ? "We are getting your delivery order ready for dispatch."
            : "Please head to the store for pickup.",
        payload.fulfillmentType === "delivery"
            ? "We will keep you posted here if anything changes."
            : "Show this order ID at pickup if the store asks for it.",
    ].join("\n"),
});

const orderCancelledNotificationHandler = defineNotificationHandler({
    type: "order_cancelled",
    payloadSchema: orderCancelledPayloadSchema,
    buildMessage: (payload) => [
        `Your order ${payload.orderId} from ${payload.storeName} has been cancelled.`,
        `Reason: ${payload.reason}`,
        "We're sorry for the inconvenience. Please contact the store if you have any questions.",
    ].join("\n"),
});

const paymentReceivedNotificationHandler = defineNotificationHandler({
    type: "payment_received",
    payloadSchema: paymentReceivedPayloadSchema,
    buildMessage: (payload) => [
        `Payment received for order ${payload.orderId}.`,
        `Store: ${payload.storeName}`,
        `Total: $${payload.total.toFixed(2)}`,
        payload.orderStatus === "queued_for_open"
            ? "The store is currently closed, so your order is queued and will be processed after reopening."
            : "We have your order and will send the next update here.",
        "You can reply status any time to check progress.",
    ].join("\n"),
});

const notificationHandlers = {
    order_ready: orderReadyNotificationHandler,
    order_cancelled: orderCancelledNotificationHandler,
    payment_received: paymentReceivedNotificationHandler,
} satisfies Record<NotificationType, NotificationHandler>;

export function getOrderStatusNotificationType(status: OrderStatus): NotificationType | null {
    return ORDER_STATUS_NOTIFICATION_TYPES[status] ?? null;
}

export function createOrderStatusNotificationInput(input: {
    orderId: string;
    status: OrderStatus;
    storeName: string;
    fulfillmentType: FulfillmentType;
    channel: string;
    channelIdentifier: string;
    customerPhone: string;
    cancellationReason?: string;
}): CreateNotificationInput | null {
    const type = getOrderStatusNotificationType(input.status);
    if (!type) {
        return null;
    }

    let payload: NotificationPayload;
    if (type === "order_cancelled") {
        if (!input.cancellationReason) {
            return null;
        }
        payload = {
            orderId: input.orderId,
            storeName: input.storeName,
            reason: input.cancellationReason,
        };
    } else {
        payload = {
            orderId: input.orderId,
            storeName: input.storeName,
            fulfillmentType: input.fulfillmentType,
        };
    }

    return {
        type,
        audience: "customer",
        channel: input.channel,
        channelIdentifier: input.channelIdentifier,
        recipient: input.customerPhone,
        entityType: "order",
        entityId: input.orderId,
        dedupeKey: `order-status:${input.orderId}:${input.status}`,
        payload,
    };
}

export function getNotificationHandler(type: string): NotificationHandler | null {
    if (!(type in notificationHandlers)) {
        return null;
    }

    return notificationHandlers[type as NotificationType];
}

export function buildNotificationMessage(
    notification: NotificationRecord,
    handler: NotificationHandler
): string | null {
    const payload = handler.payloadSchema.parse(notification.payload);
    return handler.buildMessage(payload, notification);
}
