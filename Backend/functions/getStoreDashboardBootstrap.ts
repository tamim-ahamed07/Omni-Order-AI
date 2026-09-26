import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { activeDashboardOrderStatuses, listStoreDashboardOrders } from "../services/storeOperationsService";
import { deviceUnauthorizedResponse, parseStoreId, requireDeviceForStore } from "./deviceAuthHelpers";

async function getStoreDashboardBootstrapHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const storeId = parseStoreId(request.params.storeId);
    if (storeId === null) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "Invalid storeId — must be an integer" } };
    }

    const device = await requireDeviceForStore(request, storeId);
    if (!device) {
        return deviceUnauthorizedResponse();
    }

    const result = await listStoreDashboardOrders({
        storeId,
        statuses: activeDashboardOrderStatuses,
    });

    if (!result) {
        return { status: HTTP_STATUS.NOT_FOUND, jsonBody: { error: `Store ${storeId} not found` } };
    }

    context.log(`getStoreDashboardBootstrap: deviceId=${device.id}, storeId=${storeId}, orders=${result.orders.length}`);
    return {
        status: HTTP_STATUS.OK,
        jsonBody: {
            device,
            store: {
                id: result.store.id,
                name: result.store.name,
                address: result.store.address,
                hours: result.store.hours,
                settings: result.store.settings,
            },
            menuVersion: result.store.menuVersion,
            orders: result.orders,
        },
    };
}

app.http("getStoreDashboardBootstrap", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "stores/{storeId}/dashboard-bootstrap",
    handler: getStoreDashboardBootstrapHandler,
});
