import { InvocationContext } from "@azure/functions";
import { ChannelFactory, ChannelType } from "../channels/ChannelFactory";
import { getStoreChannelReplyContext } from "../shared/catalogStore";
import {
    claimNotificationProcessing,
    getErrorDetails,
    getNotificationById,
    markNotificationSent,
    markNotificationSkipped,
    releaseNotificationProcessing,
} from "../shared/sqlClient";
import { buildNotificationMessage, getNotificationHandler } from "./notificationService";

function isChannelType(value: string): value is ChannelType {
    return Object.values(ChannelType).includes(value as ChannelType);
}

function toNotificationErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message.slice(0, 1000);
    }

    return JSON.stringify(getErrorDetails(error)).slice(0, 1000);
}

export async function deliverPendingNotification(notificationId: number, context: InvocationContext): Promise<void> {
    const notification = await claimNotificationProcessing(notificationId);
    if (!notification) {
        const existing = await getNotificationById(notificationId);
        if (!existing) {
            throw new Error(`Notification ${notificationId} not found`);
        }

        context.log("Skipping notification because it is not pending", {
            notificationId,
            deliveryStatus: existing.deliveryStatus,
        });
        return;
    }

    try {
        const handler = getNotificationHandler(notification.type);
        if (!handler) {
            await markNotificationSkipped(
                notification.id,
                `No handler configured for notification type ${notification.type}`
            );
            return;
        }

        const message = buildNotificationMessage(notification, handler);
        if (!message) {
            await markNotificationSkipped(
                notification.id,
                `Handler ${handler.type} produced no message`
            );
            return;
        }

        if (!isChannelType(notification.channel)) {
            context.log(`Skipping notification for unsupported channel ${notification.channel}`);
            await markNotificationSkipped(
                notification.id,
                `Unsupported channel ${notification.channel}`
            );
            return;
        }

        const replyContext = await getStoreChannelReplyContext(notification.channel, notification.channelIdentifier);
        if (!replyContext) {
            throw new Error(`Reply context not found for ${notification.channel}/${notification.channelIdentifier}`);
        }

        const channel = ChannelFactory.getChannel(notification.channel);
        await channel.sendMessage(notification.recipient, message, context, replyContext);
        await markNotificationSent(notification.id);

        context.log("Notification sent", {
            notificationId: notification.id,
            type: notification.type,
            recipient: notification.recipient,
        });
    } catch (error) {
        await releaseNotificationProcessing(notification.id, toNotificationErrorMessage(error));
        throw error;
    }
}
