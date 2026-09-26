import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { changeStoreOrderStatus } from "../services/storeOperationsService";
import { deviceUnauthorizedResponse, parseStoreId, requireDeviceForStore } from "./deviceAuthHelpers";
import { getErrorDetails } from "../shared/sqlClient";

async function acceptStoreOrderHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
        const result = await changeStoreOrderStatus({
            storeId,
            orderId,
            nextStatus: "accepted",
            note: "Order accepted from dashboard",
        });

        if (!result) {
            return { status: HTTP_STATUS.NOT_FOUND, jsonBody: { error: `Order ${orderId} not found for store ${storeId}` } };
        }

        context.log(`acceptStoreOrder: deviceId=${device.id}, storeId=${storeId}, orderId=${orderId}`);
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

        context.error("acceptStoreOrder failed", {
            storeId,
            orderId,
            error: getErrorDetails(error),
        });
        return {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            jsonBody: { error: "Failed to accept order" },
        };
    }
}

app.http("acceptStoreOrder", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "stores/{storeId}/orders/{orderId}/accept",
    handler: acceptStoreOrderHandler,
});
