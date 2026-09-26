import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { z, ZodError } from "zod";
import { DEFAULT_CURRENCY, HTTP_STATUS, ORDER_ID_PREFIX } from "../config/constants";
import { getEnvironmentConfig } from "../config/environment";
import { calculateCartTotals, requestedOrderItemsSchema, validateRequestedOrderItems } from "../services/cartService";
import { createCheckoutSession } from "../services/paymentService";
import { attachStripeCheckoutSession, createOrder, getErrorDetails } from "../shared/sqlClient";
import { getStoreInfoBySlug } from "../shared/catalogStore";

const checkoutRequestSchema = z.object({
    customerName: z.string().trim().min(1).max(120),
    customerPhone: z.string().trim().min(7).max(32),
    items: requestedOrderItemsSchema.min(1),
}).strict();

function generateOrderId(): string {
    return `${ORDER_ID_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createStorefrontCheckout(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const slug = request.params.slug?.trim();
    if (!slug) {
        return {
            status: HTTP_STATUS.BAD_REQUEST,
            jsonBody: { error: "Missing store slug" },
        };
    }

    try {
        const body = checkoutRequestSchema.parse(await request.json());
        const store = await getStoreInfoBySlug(slug);
        if (!store) {
            return {
                status: HTTP_STATUS.NOT_FOUND,
                jsonBody: { error: `Store ${slug} not found` },
            };
        }

        const orderItems = validateRequestedOrderItems(store.menu, body.items);
        const { subtotal, feeTotal, tax, total } = calculateCartTotals(orderItems, store.pricing);
        const orderId = generateOrderId();
        const queuedForOpen = !store.settings.isOpen;
        const productName = `${store.name} order ${orderId}`;
        const productDescription = orderItems.map((item) => {
            const options = item.selectedOptions.map((selection) => `${selection.optionName ?? selection.optionId}: ${selection.choiceName ?? selection.choiceId}`).join(", ");
            return `${item.quantity}x ${item.itemName}${options ? ` (${options})` : ""}`;
        }).join(", ");

        // Order is created at its active status immediately; the payments table tracks payment state.
        await createOrder({
            id: orderId,
            storeId: store.id,
            storeName: store.name,
            fulfillmentType: "pickup",
            channel: "web",
            channelIdentifier: store.slug,
            customerPhone: body.customerPhone,
            customerName: body.customerName,
            items: orderItems,
            subtotal,
            feeTotal,
            tax,
            total,
            currency: DEFAULT_CURRENCY,
            initialStatus: queuedForOpen ? "queued_for_open" : "new",
            initialStatusNote: queuedForOpen ? "Web order created — store currently closed" : "Web order created",
        });

        const cancelUrl = `${getEnvironmentConfig().payment.storefrontBaseUrl}/stores/${encodeURIComponent(slug)}/order`;
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const checkoutSession = await createCheckoutSession({
            orderId,
            storeId: store.id.toString(),
            storeSlug: slug,
            productName,
            productDescription: `${productDescription}, Total: ${total.toFixed(2)} ${DEFAULT_CURRENCY}`,
            total,
            currency: DEFAULT_CURRENCY,
            cancelUrl,
            expiresAt,
        });

        await attachStripeCheckoutSession({
            orderId,
            stripeCheckoutSessionId: checkoutSession.id,
            checkoutUrl: checkoutSession.url,
            expiresAt,
        });

        context.log("createStorefrontCheckout created order", {
            slug,
            storeId: store.id,
            orderId,
            itemCount: orderItems.length,
            queuedForOpen,
        });

        return {
            status: HTTP_STATUS.OK,
            jsonBody: {
                orderId,
                checkoutUrl: checkoutSession.url,
                expiresAt: expiresAt.getTime(),
                queuedForOpen,
            },
        };
    } catch (error) {
        if (error instanceof ZodError) {
            return {
                status: HTTP_STATUS.BAD_REQUEST,
                jsonBody: {
                    error: "Invalid checkout request",
                    issues: error.issues,
                },
            };
        }

        context.error("createStorefrontCheckout failed", {
            slug,
            error: getErrorDetails(error),
        });
        return {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            jsonBody: { error: "Failed to create checkout" },
        };
    }
}

app.http("createStorefrontCheckout", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "public/stores/{slug}/checkout",
    handler: createStorefrontCheckout,
});
