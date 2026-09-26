import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createHmac, timingSafeEqual } from "crypto";
import { WhatsAppWebhookPayload } from "../types/WhatsAppTypes";
import { ChannelFactory, ChannelType } from "../channels/ChannelFactory";
import { enqueue } from "../shared/queueClient";
import { getEnvironmentConfig } from "../config/environment";
import { SUCCESS_MESSAGES, HTTP_STATUS, QUEUE_INCOMING_MESSAGES } from "../config/constants";

const channel = ChannelFactory.getChannel(ChannelType.WHATSAPP);

export async function whatsAppWebHook(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`WhatsApp webhook: ${request.method} ${request.url}`);

    if (request.method === 'GET') {
        return channel.validateWebhook(request, context) ?? { status: HTTP_STATUS.FORBIDDEN, body: 'Forbidden' };
    }

    if (request.method === 'POST') {
        return await handleIncomingMessage(request, context);
    }

    return { status: HTTP_STATUS.METHOD_NOT_ALLOWED, body: 'Method Not Allowed' };
}

async function handleIncomingMessage(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    // Read raw body once — needed for both signature verification and parsing
    const rawBody = await request.text();
    if (process.env.DEBUG_LOGGING === "true") {
        context.log(`[debug] Raw webhook body (${rawBody.length}B): ${rawBody}`);
    }

    if (!verifyWhatsAppSignature(request, rawBody, context)) {
        return { status: HTTP_STATUS.FORBIDDEN, body: 'Forbidden' };
    }

    const body = JSON.parse(rawBody) as WhatsAppWebhookPayload;

    if (!body.entry?.[0]?.changes?.[0]?.value) {
        context.log('Unsupported webhook event — acknowledging');
        return { status: HTTP_STATUS.OK, body: SUCCESS_MESSAGES.EVENT_ACKNOWLEDGED };
    }

    if (!body.entry[0].changes[0].value.messages) {
        context.log('Non-message event (status update) — acknowledging');
        return { status: HTTP_STATUS.OK, body: SUCCESS_MESSAGES.STATUS_UPDATE_ACKNOWLEDGED };
    }

    // Extract per-sender messages and push each to the queue
    const messagesByFrom = channel.extractMessages(body);
    const enqueueOps = Object.entries(messagesByFrom).map(([customerPhone, messages]) => {
        const channelIdentifier = channel.getSessionKey(messages[0]);
        const customerName = messages[0].contactName;
        const text = channel.extractMessageTexts(messages);
        const messageId = messages[0].id;
        context.log(`Queuing message from ${customerPhone} → channel ${channelIdentifier}`);
        return enqueue(QUEUE_INCOMING_MESSAGES, {
            customerPhone,
            customerName,
            channelIdentifier,
            channel: ChannelType.WHATSAPP,
            text,
            receivedAt: new Date().toISOString(),
            messageId,
        });
    });

    await Promise.all(enqueueOps);

    // Return 200 immediately — AI processing happens in the queue worker
    return { status: HTTP_STATUS.OK };
}

/**
 * Verifies the X-Hub-Signature-256 header using HMAC-SHA256 of the raw request body.
 * Uses timing-safe comparison to prevent timing attacks.
 * Set SKIP_WEBHOOK_SIGNATURE_VERIFICATION=true in local.settings.json to bypass during local dev.
 */
function verifyWhatsAppSignature(request: HttpRequest, rawBody: string, context: InvocationContext): boolean {
    if (process.env.SKIP_WEBHOOK_SIGNATURE_VERIFICATION === 'true') {
        context.warn("⚠️  Webhook signature verification SKIPPED — local dev only");
        return true;
    }

    const signature = request.headers.get('x-hub-signature-256');
    if (!signature) {
        context.warn("Missing X-Hub-Signature-256 header");
        return false;
    }

    const { whatsapp } = getEnvironmentConfig();
    const expected = `sha256=${createHmac('sha256', whatsapp.appSecret).update(rawBody).digest('hex')}`;

    try {
        return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
        // Buffers of different lengths — signature mismatch
        return false;
    }
}

app.http('whatsAppWebHook', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: whatsAppWebHook,
});
