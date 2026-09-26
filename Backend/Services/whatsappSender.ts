import { InvocationContext } from "@azure/functions";
import { ChannelReplyContext } from "../interfaces/IMessagingChannel";
import { WHATSAPP_API_VERSION, WHATSAPP_BASE_URL, ERROR_MESSAGES } from "../config/constants";
import { getErrorDetails } from "../shared/sqlClient";

const WHATSAPP_TEXT_BODY_LIMIT = 4096;

interface WhatsAppReplyConfig {
    senderId: string;
    accessTokenBase64: string;
}

function decodeBase64(value: string): string {
    return Buffer.from(value, "base64").toString("utf8");
}

function getWhatsAppReplyConfig(replyContext: ChannelReplyContext): { senderId: string; accessToken: string } {
    const config = replyContext.config as Partial<WhatsAppReplyConfig>;
    if (!config.senderId || !config.accessTokenBase64) {
        throw new Error(`WhatsApp reply config is incomplete for ${replyContext.channel}/${replyContext.channelIdentifier}`);
    }

    return {
        senderId: config.senderId,
        accessToken: decodeBase64(config.accessTokenBase64),
    };
}

function summarizeToken(value: string): { length: number; prefix: string; suffix: string } {
    return {
        length: value.length,
        prefix: value.slice(0, 6),
        suffix: value.slice(-6),
    };
}

function pushChunk(chunks: string[], chunk: string): void {
    const trimmed = chunk.trim();
    if (trimmed.length > 0) {
        chunks.push(trimmed);
    }
}

function splitOversizedSegment(segment: string, separator: string): string[] {
    if (segment.length <= WHATSAPP_TEXT_BODY_LIMIT) {
        return [segment];
    }

    const parts = segment.split(separator);
    if (parts.length === 1) {
        const hardChunks: string[] = [];
        for (let start = 0; start < segment.length; start += WHATSAPP_TEXT_BODY_LIMIT) {
            pushChunk(hardChunks, segment.slice(start, start + WHATSAPP_TEXT_BODY_LIMIT));
        }
        return hardChunks;
    }

    const chunks: string[] = [];
    let current = "";

    for (const part of parts) {
        const piece = current ? `${current}${separator}${part}` : part;
        if (piece.length <= WHATSAPP_TEXT_BODY_LIMIT) {
            current = piece;
            continue;
        }

        pushChunk(chunks, current);
        if (part.length <= WHATSAPP_TEXT_BODY_LIMIT) {
            current = part;
            continue;
        }

        const nestedSeparator = separator === "\n\n" ? "\n" : "";
        const nestedChunks = nestedSeparator
            ? splitOversizedSegment(part, nestedSeparator)
            : splitOversizedSegment(part, separator);

        if (nestedChunks.length === 0) {
            current = "";
            continue;
        }

        chunks.push(...nestedChunks.slice(0, -1));
        current = nestedChunks[nestedChunks.length - 1] ?? "";
    }

    pushChunk(chunks, current);
    return chunks;
}

function splitWhatsAppMessage(message: string): string[] {
    const normalized = message.trim();
    if (normalized.length <= WHATSAPP_TEXT_BODY_LIMIT) {
        return [normalized];
    }

    return splitOversizedSegment(normalized, "\n\n");
}

async function postWhatsAppMessage(
    phoneNumber: string,
    message: string,
    context: InvocationContext,
    config: { senderId: string; accessToken: string }
): Promise<void> {
    const url = `${WHATSAPP_BASE_URL}/${WHATSAPP_API_VERSION}/${config.senderId}/messages`;
    const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phoneNumber,
        type: "text",
        text: {
            body: message,
        },
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorData = await response.json();
        context.error(`Failed to send WhatsApp message: ${response.status}`, errorData);
        throw new Error(`${ERROR_MESSAGES.WHATSAPP_API_ERROR}: ${response.status}`);
    }

    const result = await response.json();
    context.log(`WhatsApp message sent to ${phoneNumber}: {messageId: ${result.messages?.[0]?.id}}`);
}

export async function sendWhatsAppMessage(
    phoneNumber: string,
    message: string,
    context: InvocationContext,
    replyContext: ChannelReplyContext
): Promise<void> {
    const config = getWhatsAppReplyConfig(replyContext);
    const messageChunks = splitWhatsAppMessage(message);

    try {
        if (messageChunks.length > 1) {
            context.log(`Splitting WhatsApp message for ${phoneNumber} into ${messageChunks.length} chunks`, {
                originalLength: message.length,
            });
        }

        for (const chunk of messageChunks) {
            await postWhatsAppMessage(phoneNumber, chunk, context, config);
        }
    } catch (error: any) {
        context.error("Error sending WhatsApp message", { error: getErrorDetails(error) });
        throw error;
    }
}

/**
 * Mark an incoming WhatsApp message as read. This causes WhatsApp to show
 * blue double-checkmarks (✓✓) to the customer, signalling the message was received.
 * Call fire-and-forget after picking up a queue message — provides immediate visual
 * feedback while the AI processes the order.
 */
export async function sendWhatsAppReadReceipt(
    messageId: string,
    context: InvocationContext,
    replyContext: ChannelReplyContext
): Promise<void> {
    const config = getWhatsAppReplyConfig(replyContext);
    const url = `${WHATSAPP_BASE_URL}/${WHATSAPP_API_VERSION}/${config.senderId}/messages`;
    const payload = {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        context.warn("Failed to send WhatsApp read receipt", { messageId, status: response.status, error: errorData });
    }
}

export async function sendWhatsAppMessages(
    replies: Record<string, string>,
    context: InvocationContext,
    replyContext: ChannelReplyContext
): Promise<void> {
    const promises = Object.entries(replies).map(([phoneNumber, message]) =>
        sendWhatsAppMessage(phoneNumber, message, context, replyContext).catch((err) => {
            context.error(`Failed to send message to ${phoneNumber}:`, err);
        })
    );

    await Promise.all(promises);
}
