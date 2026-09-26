import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { getStoreDashboardOrder } from "../services/storeOperationsService";
import { deviceUnauthorizedResponse, parseStoreId, requireDeviceForStore } from "./deviceAuthHelpers";

async function getStoreOrderHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

    const result = await getStoreDashboardOrder({ storeId, orderId });
    if (!result) {
        return { status: HTTP_STATUS.NOT_FOUND, jsonBody: { error: `Order ${orderId} not found for store ${storeId}` } };
    }

    context.log(`getStoreOrder: deviceId=${device.id}, storeId=${storeId}, orderId=${orderId}, status=${result.order.status}`);
    return {
        status: HTTP_STATUS.OK,
        jsonBody: {
            device,
            store: {
                id: result.store.id,
                name: result.store.name,
                settings: result.store.settings,
            },
            order: result.order,
        },
    };
}

app.http("getStoreOrder", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "stores/{storeId}/orders/{orderId}",
    handler: getStoreOrderHandler,
});
