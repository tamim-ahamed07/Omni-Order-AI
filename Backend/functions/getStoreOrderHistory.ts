import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { getStoreDashboardOrderHistory } from "../services/storeOperationsService";
import { deviceUnauthorizedResponse, parseStoreId, requireDeviceForStore } from "./deviceAuthHelpers";

async function getStoreOrderHistoryHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

    const result = await getStoreDashboardOrderHistory({ storeId, orderId });
    if (!result) {
        return { status: HTTP_STATUS.NOT_FOUND, jsonBody: { error: `Order ${orderId} not found for store ${storeId}` } };
    }

    context.log(`getStoreOrderHistory: deviceId=${device.id}, storeId=${storeId}, orderId=${orderId}, events=${result.history.length}`);
    return {
        status: HTTP_STATUS.OK,
        jsonBody: {
            device,
            store: {
                id: result.store.id,
                name: result.store.name,
                settings: result.store.settings,
            },
            history: result.history,
        },
    };
}

app.http("getStoreOrderHistory", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "stores/{storeId}/orders/{orderId}/history",
    handler: getStoreOrderHistoryHandler,
});
