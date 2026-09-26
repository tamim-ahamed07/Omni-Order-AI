import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { verifyOrderStatusToken } from "../shared/orderStatusToken";
import { getOrderById, getOrderStatusHistory } from "../shared/sqlClient";

export async function getPublicOrderStatus(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const orderId = request.params.orderId?.trim();
    const statusToken = request.query.get("token");

    if (!orderId || !verifyOrderStatusToken(orderId, statusToken)) {
        return {
            status: HTTP_STATUS.NOT_FOUND,
            jsonBody: { error: "Order not found" },
        };
    }

    const order = await getOrderById(orderId);
    if (!order) {
        return {
            status: HTTP_STATUS.NOT_FOUND,
            jsonBody: { error: "Order not found" },
        };
    }

    const history = (await getOrderStatusHistory(orderId)).slice().reverse();
    context.log(`getPublicOrderStatus: orderId=${orderId}, status=${order.status}, payment=${order.paymentStatus}`);

    return {
        status: HTTP_STATUS.OK,
        jsonBody: {
            orderId: order.id,
            storeName: order.storeName,
            status: order.status,
            paymentStatus: order.paymentStatus,
            subtotal: order.subtotal,
            feeTotal: order.feeTotal,
            tax: order.tax,
            total: order.total,
            currency: order.currency,
            fulfillmentType: order.fulfillmentType,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            items: order.items,
            history,
        },
    };
}

app.http("getPublicOrderStatus", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "public/orders/{orderId}/status",
    handler: getPublicOrderStatus,
});
