import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { z } from "zod";
import { HTTP_STATUS } from "../config/constants";
import { changeStoreOrderStatus } from "../services/storeOperationsService";
import { deviceUnauthorizedResponse, parseStoreId, requireDeviceForStore } from "./deviceAuthHelpers";

const cancelOrderBodySchema = z.object({
    reason: z.string().trim().min(1).max(200),
    note: z.string().trim().max(500).optional(),
});

async function cancelStoreOrderHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const storeId = parseStoreId(request.params.storeId);
    if (storeId === null) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "Invalid storeId — must be an integer" } };
    }

    const device = await requireDeviceForStore(request, storeId);
    if (!device) {
        return deviceUnauthorizedResponse();
    }

    const orderId = request.params.orderId;
    if (!orderId) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "Missing orderId" } };
    }

    const bodyParse = cancelOrderBodySchema.safeParse(await request.json().catch(() => ({})));
    if (!bodyParse.success) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "A cancellation reason is required", details: bodyParse.error.flatten() } };
    }

    const { reason, note } = bodyParse.data;
    const noteText = [reason, note].filter(Boolean).join(" — ");

    try {
        const result = await changeStoreOrderStatus({
            storeId,
            orderId,
            nextStatus: "cancelled",
            note: noteText,
            cancellationReason: reason,
        });

        if (!result) {
            return { status: HTTP_STATUS.NOT_FOUND, jsonBody: { error: `Order ${orderId} not found for store ${storeId}` } };
        }

        context.log(`cancelStoreOrder: deviceId=${device.id}, storeId=${storeId}, orderId=${orderId}, reason=${reason}`);
        return {
            status: HTTP_STATUS.OK,
            jsonBody: { order: result.order },
        };
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("Invalid order status transition")) {
            return {
                status: HTTP_STATUS.CONFLICT,
                jsonBody: { error: error.message },
            };
        }

        context.error("cancelStoreOrder failed", {
            storeId,
            orderId,
            error,
        });
        return {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            jsonBody: { error: "Failed to cancel order" },
        };
    }
}

app.http("cancelStoreOrder", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "stores/{storeId}/orders/{orderId}/cancel",
    handler: cancelStoreOrderHandler,
});
