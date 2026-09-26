import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { z } from "zod";
import { HTTP_STATUS } from "../config/constants";
import { activeDashboardOrderStatuses, listStoreDashboardOrders, orderStatusSchema } from "../services/storeOperationsService";
import { deviceUnauthorizedResponse, parseStoreId, requireDeviceForStore } from "./deviceAuthHelpers";

const queryStatusesSchema = z.array(orderStatusSchema).min(1);

async function listStoreOrdersHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const storeId = parseStoreId(request.params.storeId);
    if (storeId === null) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "Invalid storeId — must be an integer" } };
    }

    const device = await requireDeviceForStore(request, storeId);
    if (!device) {
        return deviceUnauthorizedResponse();
    }

    const statusesParam = request.query.get("status");
    const statuses = statusesParam
        ? queryStatusesSchema.parse(
            statusesParam.split(",").map((status) => status.trim()).filter((status) => status.length > 0)
        )
        : activeDashboardOrderStatuses;

    const result = await listStoreDashboardOrders({ storeId, statuses });
    if (!result) {
        return { status: HTTP_STATUS.NOT_FOUND, jsonBody: { error: `Store ${storeId} not found` } };
    }

    context.log(`listStoreOrders: deviceId=${device.id}, storeId=${storeId}, statuses=${statuses.join(",")}, orders=${result.orders.length}`);
    return {
        status: HTTP_STATUS.OK,
        jsonBody: {
            device,
            store: {
                id: result.store.id,
                name: result.store.name,
                settings: result.store.settings,
            },
            orders: result.orders,
        },
    };
}

app.http("listStoreOrders", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "stores/{storeId}/orders",
    handler: listStoreOrdersHandler,
});
