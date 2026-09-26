import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { activeDashboardOrderStatuses, listStoreDashboardOrders } from "../services/storeOperationsService";
import { deviceUnauthorizedResponse, requireAuthenticatedDevice } from "./deviceAuthHelpers";

async function getDeviceBootstrapHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const device = await requireAuthenticatedDevice(request);
    if (!device) {
        return deviceUnauthorizedResponse();
    }

    const result = await listStoreDashboardOrders({
        storeId: device.storeId,
        statuses: activeDashboardOrderStatuses,
    });

    if (!result) {
        return { status: HTTP_STATUS.NOT_FOUND, jsonBody: { error: `Store ${device.storeId} not found` } };
    }

    context.log(`getDeviceBootstrap: deviceId=${device.id}, storeId=${device.storeId}, orders=${result.orders.length}`);
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

app.http("getDeviceBootstrap", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "device/bootstrap",
    handler: getDeviceBootstrapHandler,
});
