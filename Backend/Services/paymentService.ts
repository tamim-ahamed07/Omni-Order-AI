import Stripe from "stripe";
import { getEnvironmentConfig } from "../config/environment";
import { generateOrderStatusToken } from "../shared/orderStatusToken";

let stripeClient: Stripe | null = null;

function getStripeClient(): Stripe {
    if (!stripeClient) {
        stripeClient = new Stripe(getEnvironmentConfig().stripe.secretKey);
    }

    return stripeClient;
}

export interface CreateCheckoutSessionInput {
    orderId: string;
    storeId: string;
    storeSlug?: string;
    productName: string;
    productDescription: string;
    total: number;
    currency: string;
    cancelUrl?: string;
    expiresAt?: Date;
}

export interface CheckoutSessionResult {
    id: string;
    url: string;
}

export function constructStripeWebhookEvent(rawBody: string, signature: string): Stripe.Event {
    return getStripeClient().webhooks.constructEvent(
        rawBody,
        signature,
        getEnvironmentConfig().stripe.webhookSecret
    );
}

export async function createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResult> {
    const slug = input.storeSlug ?? input.storeId;
    const successUrl = new URL(
        `${getEnvironmentConfig().payment.storefrontBaseUrl}/stores/${encodeURIComponent(slug)}/order/success`
    );
    successUrl.searchParams.set("orderId", input.orderId);
    successUrl.searchParams.set("statusToken", generateOrderStatusToken(input.orderId));

    const session = await getStripeClient().checkout.sessions.create({
        mode: "payment",
        client_reference_id: input.orderId,
        success_url: successUrl.toString(),
        ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
        ...(input.expiresAt ? { expires_at: Math.floor(input.expiresAt.getTime() / 1000) } : {}),
        line_items: [
            {
                quantity: 1,
                price_data: {
                    currency: input.currency,
                    unit_amount: Math.round(input.total * 100),
                    product_data: {
                        name: input.productName,
                        description: input.productDescription,
                    },
                },
            },
        ],
    });

    if (!session.url) {
        throw new Error(`Stripe Checkout Session ${session.id} did not include a checkout URL.`);
    }

    return {
        id: session.id,
        url: session.url,
    };
}

export function getPaymentIntentId(
    paymentIntent: string | Stripe.PaymentIntent | null
): string | null {
    if (!paymentIntent) {
        return null;
    }

    return typeof paymentIntent === "string" ? paymentIntent : paymentIntent.id;
}
