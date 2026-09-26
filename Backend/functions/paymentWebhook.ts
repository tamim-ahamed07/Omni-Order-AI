import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import Stripe from "stripe";
import { HTTP_STATUS, QUEUE_PAYMENT_EVENTS } from "../config/constants";
import { enqueue } from "../shared/queueClient";
import { getErrorDetails, recordStripeWebhookEvent } from "../shared/sqlClient";
import { constructStripeWebhookEvent, getPaymentIntentId } from "../services/paymentService";

interface PaymentEventQueueMessage {
    stripeEventId: string;
}

function getCheckoutSessionFromEvent(event: Stripe.Event): Stripe.Checkout.Session | null {
    if (
        event.type !== "checkout.session.completed"
        && event.type !== "checkout.session.async_payment_succeeded"
        && event.type !== "checkout.session.expired"
    ) {
        return null;
    }

    const session = event.data.object;
    if (session.object !== "checkout.session") {
        return null;
    }

    return session as Stripe.Checkout.Session;
}

export async function paymentWebhook(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const rawBody = await request.text();
    const signature = request.headers.get("stripe-signature");

    if (!signature) {
        context.warn("Missing Stripe-Signature header");
        return {
            status: HTTP_STATUS.BAD_REQUEST,
            jsonBody: { error: "Missing Stripe-Signature header" },
        };
    }

    let event: Stripe.Event;
    try {
        event = constructStripeWebhookEvent(rawBody, signature);
    } catch (error) {
        context.error("paymentWebhook signature validation failed", {
            error: getErrorDetails(error),
        });
        return {
            status: HTTP_STATUS.BAD_REQUEST,
            jsonBody: { error: "Invalid Stripe webhook payload" },
        };
    }

    const session = getCheckoutSessionFromEvent(event);

    if (!session) {
        context.log(`Ignoring Stripe webhook event ${event.id} (${event.type})`);
        return {
            status: HTTP_STATUS.OK,
            jsonBody: { received: true, ignored: true },
        };
    }

    const orderId = session.client_reference_id ?? null;
    if (!orderId) {
        context.error("Stripe checkout session missing client_reference_id", {
            stripeEventId: event.id,
            stripeCheckoutSessionId: session.id,
        });
        return {
            status: HTTP_STATUS.BAD_REQUEST,
            jsonBody: { error: "Stripe checkout session is missing client_reference_id" },
        };
    }

    try {
        const result = await recordStripeWebhookEvent({
            orderId,
            stripeEventId: event.id,
            stripeCheckoutSessionId: session.id,
            stripePaymentIntentId: getPaymentIntentId(session.payment_intent),
            eventType: event.type,
            payload: event,
        });

        const queueMessage: PaymentEventQueueMessage = {
            stripeEventId: event.id,
        };
        await enqueue(QUEUE_PAYMENT_EVENTS, queueMessage);

        context.log("Stripe webhook recorded", {
            stripeEventId: event.id,
            eventType: event.type,
            orderId,
            alreadyRecorded: result.alreadyRecorded,
            processedAt: result.processedAt,
        });

        return {
            status: HTTP_STATUS.OK,
            jsonBody: { received: true },
        };
    } catch (error) {
        context.error("paymentWebhook failed", {
            error: getErrorDetails(error),
        });
        return {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            jsonBody: { error: "Failed to record Stripe webhook event" },
        };
    }
}

app.http("paymentWebhook", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "payment/webhook",
    handler: paymentWebhook,
});
