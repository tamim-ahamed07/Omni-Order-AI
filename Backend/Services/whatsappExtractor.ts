import { WhatsAppWebhookPayload, Entry, Change, Message, Contact, WebhookMetadata } from "../types/WhatsAppTypes";
import { ExtractedMessage } from "../interfaces/IMessagingChannel";

export type ExtractedMessagesByFrom = Record<string, ExtractedMessage[]>;

function normalizeToArray<T>(maybeArray: T | T[] | undefined | null): T[] {
  if (!maybeArray) return [];
  return Array.isArray(maybeArray) ? maybeArray : [maybeArray];
}

function getTextFromMessage(msg: any): string | undefined {
  // Basic text message
  if (msg?.text?.body) return String(msg.text.body);
  // Button replies
  if (msg?.button?.text) return String(msg.button.text);
  // Interactive list/button replies
  if (msg?.interactive?.list_reply?.title) return String(msg.interactive.list_reply.title);
  if (msg?.interactive?.button_reply?.title) return String(msg.interactive.button_reply.title);
  return undefined;
}

export function extractWhatsAppMessages(body: WhatsAppWebhookPayload): ExtractedMessagesByFrom {
  const results: ExtractedMessage[] = [];

  const entries = normalizeToArray<Entry>(body?.entry);
  for (const entry of entries) {
    const changes = normalizeToArray<Change>(entry?.changes);
    for (const change of changes) {
      const value = change?.value ?? ({} as Change["value"]);
      const messages = normalizeToArray<Message>(value?.messages);
      const contacts = normalizeToArray<Contact>(value?.contacts);

      const meta: WebhookMetadata | undefined = value?.metadata;
      const contact = contacts[0];

      for (const msg of messages) {
        results.push({
          id: msg?.id,
          customerPhone: msg?.from,
          timestamp: msg?.timestamp,
          type: msg?.type,
          text: getTextFromMessage(msg),
          contactName: contact?.profile?.name,
          channelData: {
            waId: contact?.wa_id,
            phoneNumberId: meta?.phone_number_id,
            displayPhoneNumber: meta?.display_phone_number,
          },
          raw: msg,
        });
      }
    }
  }

  // Group by "from" (fallback to waId or 'unknown') and sort by timestamp ascending
  const grouped: ExtractedMessagesByFrom = {};
  for (const msg of results) {
    const key = msg.customerPhone ?? msg.channelData.waId ?? 'unknown';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(msg);
  }

  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));
  }

  return grouped;
}

/**
 * Concatenate all text bodies from a sender's messages in chronological order.
 * Non-text messages are skipped.
 */
export function extractWhatsAppMessageTexts(msgs: ExtractedMessage[]): string {
  if (!Array.isArray(msgs) || msgs.length === 0) return "";
  const sorted = [...msgs].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));
  const parts: string[] = [];
  for (const m of sorted) {
    const t = (m.text ?? "").toString().trim();
    if (t) parts.push(t);
  }
  return parts.join("\n");
}
