import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ZodError } from "zod";
import { HTTP_STATUS } from "../config/constants";
import { changeStoreOrderStatus, updateOrderStatusRequestSchema } from "../services/storeOperationsService";
import { deviceUnauthorizedResponse, parseStoreId, requireDeviceForStore } from "./deviceAuthHelpers";

async function updateStoreOrderStatusHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

    try {
        const body = updateOrderStatusRequestSchema.parse(await request.json());
        const result = await changeStoreOrderStatus({
            storeId,
            orderId,
            nextStatus: body.status,
            note: body.note,
        });

        if (!result) {
            return { status: HTTP_STATUS.NOT_FOUND, jsonBody: { error: `Order ${orderId} not found for store ${storeId}` } };
        }

        context.log(`updateStoreOrderStatus: deviceId=${device.id}, storeId=${storeId}, orderId=${orderId}, status=${body.status}`);
        return {
            status: HTTP_STATUS.OK,
            jsonBody: {
                order: result.order,
            },
        };
    } catch (error) {
        if (error instanceof ZodError) {
            return {
                status: HTTP_STATUS.BAD_REQUEST,
                jsonBody: {
                    error: "Invalid request body",
                    issues: error.issues,
                },
            };
        }

        if (error instanceof Error && error.message.startsWith("Invalid order status transition")) {
            return {
                status: HTTP_STATUS.CONFLICT,
                jsonBody: { error: error.message },
            };
        }

        context.error("updateStoreOrderStatus failed", {
            storeId,
            orderId,
            error,
        });
        return {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            jsonBody: { error: "Failed to update order status" },
        };
    }
}

app.http("updateStoreOrderStatus", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "stores/{storeId}/orders/{orderId}/status",
    handler: updateStoreOrderStatusHandler,
});
