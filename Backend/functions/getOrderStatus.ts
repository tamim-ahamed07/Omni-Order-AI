import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getOrderById } from "../shared/sqlClient";
import { HTTP_STATUS } from "../config/constants";

/**
 * GET /api/orders/{orderId}
 * Returns the current status of an order.
 * Used as a polling fallback for customers checking their order progress.
 */
async function getOrderStatusHandler(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const orderId = req.params.orderId;

    if (!orderId) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "Missing orderId" } };
    }

    const order = await getOrderById(orderId);

    if (!order) {
        return { status: 404, jsonBody: { error: `Order ${orderId} not found` } };
    }

    context.log(`getOrderStatus: orderId=${orderId}, status=${order.status}`);
    return {
        status: HTTP_STATUS.OK,
        jsonBody: {
            orderId: order.id,
            status: order.status,
            paymentStatus: order.paymentStatus,
            fulfillmentType: order.fulfillmentType,
            storeName: order.storeName,
            subtotal: order.subtotal,
            feeTotal: order.feeTotal,
            tax: order.tax,
            total: order.total,
            items: order.items,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
        },
    };
}

app.http("getOrderStatus", {
    methods: ["GET"],
    authLevel: "function",
    route: "orders/{orderId}",
    handler: getOrderStatusHandler,
});
