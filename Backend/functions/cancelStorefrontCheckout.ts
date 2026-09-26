import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { cancelUnpaidOrder, getErrorDetails } from "../shared/sqlClient";

export async function cancelStorefrontCheckout(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const orderId = request.params.orderId?.trim();
    if (!orderId) {
        return {
            status: HTTP_STATUS.BAD_REQUEST,
            jsonBody: { error: "Missing orderId" },
        };
    }

    try {
        const cancelled = await cancelUnpaidOrder(orderId, "superseded");
        context.log("cancelStorefrontCheckout", { orderId, cancelled });
        return {
            status: HTTP_STATUS.OK,
            jsonBody: { cancelled },
        };
    } catch (error) {
        context.error("cancelStorefrontCheckout failed", {
            orderId,
            error: getErrorDetails(error),
        });
        return {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            jsonBody: { error: "Failed to cancel checkout" },
        };
    }
}

app.http("cancelStorefrontCheckout", {
    methods: ["DELETE"],
    authLevel: "anonymous",
    route: "public/checkout/{orderId}",
    handler: cancelStorefrontCheckout,
});
