import { InvocationContext } from "@azure/functions";
import { withTrace } from "@openai/agents";
import { z } from "zod";
import { ORDER_ID_PREFIX, DEFAULT_CURRENCY } from "../config/constants";
import { getEnvironmentConfig } from "../config/environment";
import { getConversation, saveConversation, saveConversationId, getCart, saveCart, deleteCart } from "../shared/stateStore";
import { getMenuItemAddOns, getMenuItemOptions, StoreMenuRecord, StorePricingRecord, StoreWithMenu } from "../shared/defaultCatalog";
import { getStoreWithMenuByChannelIdentifier, buildCompactMenuContext } from "../shared/catalogStore";
import { MessageTelemetry } from "../shared/messageTelemetry";
import { calculateOrderPricing } from "../shared/pricing";
import {
    attachStripeCheckoutSession,
    createOrder,
    getErrorDetails,
    getOrderCheckoutStateById,
    listRecentOrderSummariesByCustomer,
    OrderSummaryRecord,
} from "../shared/sqlClient";
import { trackDependency, trackEvent } from "../shared/appInsights";
import { appendConversationTurn } from "../shared/conversationArchive";
import {
    applyCartActions,
    ApplyCartActionsResult,
    cartActionsSchema,
    CartActionInput,
    extractStoredAddOnIds,
    extractStoredOptionSelections,
    formatCartSummary,
    formatStoredSelectionLabel,
    normalizeStoredCartLines,
    toOrderItems,
} from "./cartService";
import { createCheckoutSession } from "./paymentService";
import { OutboundReply, renderOutboundReply } from "../shared/outboundReply";
import { processMessage } from "../gateway/messageGateway";
import { callNano } from "../llm/nanoClient";
import { callMini } from "../llm/miniClient";
import { PLANNER_SYSTEM_PROMPT } from "../llm/prompts/systemPrompt";
import { PlannerResponse } from "../llm/plannerSchema";
import { makeSearchMenuTool } from "../retrieval/vectorSearch";
import { makeGetCartTool } from "../retrieval/cartTools";

export type WorkflowInput = {
    text: string;
    channel: string;
    customerPhone: string;
    customerName?: string;
    channelIdentifier: string;
    context: InvocationContext;
    telemetry: MessageTelemetry;
    store?: StoreWithMenu;
};

interface ToolContext {
    cacheKey: string;
    storeId: number;
    storeSlug: string;
    storeName: string;
    storeIsOpen: boolean;
    channel: string;
    customerPhone: string;
    customerName?: string;
    channelIdentifier: string;
    pricing: StorePricingRecord;
    invocationContext: InvocationContext;
    menu: StoreMenuRecord;
    currentCart: StoredCart;
    store: StoreWithMenu;
}

type StoredCart = Awaited<ReturnType<typeof getCart>>;
type ConversationStage = "shopping" | "awaiting_order_confirmation" | "submitted";

interface SubmitOrderResult {
    orderId: string;
    paymentLink: string;
    message: string;
    queuedForOpen: boolean;
}

interface ExecutionResult {
    reply: OutboundReply;
    nextStage: ConversationStage;
}

const RECENT_ORDER_CONTEXT_LIMIT = 2;

// plannerEnvelopeSchema, plannerResponseSchema, PlannerResponse imported from ../llm/plannerSchema
// PLANNER_SYSTEM_PROMPT imported from ../llm/prompts/systemPrompt

const DIRECT_SUBMIT_PHRASES = new Set([
    "confirm",
    "checkout",
    "check out",
    "submit",
    "submit order",
    "submit the order",
    "proceed",
    "proceed to checkout",
    "proceed to payment",
    "place order",
    "place the order",
    "pay",
    "pay now",
]);

const AWAITING_CONFIRMATION_PHRASES = new Set([
    "yes",
    "confirm",
    "ok",
    "okay",
    "sure",
    "yep",
    "yeah",
    "go ahead",
    "continue",
    "proceed",
]);

const MENU_REQUEST_PHRASES = new Set([
    "menu",
    "show menu",
    "see menu",
    "browse menu",
    "what do you have",
    "what s on the menu",
    "what is on the menu",
]);

/**
 * Returns true if the normalised message is a request to browse the full menu.
 * Covers exact phrases and common natural-language variants so these are handled
 * deterministically (serving the real menu widget) rather than reaching the LLM.
 */
function isMenuBrowseRequest(normalized: string): boolean {
    if (MENU_REQUEST_PHRASES.has(normalized)) return true;
    // "what's in your/the menu", "show me the menu", "view menu", etc.
    if (/\bmenu\b/.test(normalized) && /\b(what|show|see|view|browse|list|tell|share|got)\b/.test(normalized)) return true;
    // "what do you have/serve/offer/sell/make", "what can I order/eat/get"
    if (/\bwhat\b/.test(normalized) && /\b(have|serve|offer|sell|make|got|food|eat|order|available)\b/.test(normalized)) return true;
    return false;
}

const CART_REQUEST_PHRASES = new Set([
    "cart",
    "show cart",
    "view cart",
    "my cart",
    "show my cart",
    "what s in my cart",
    "what is in my cart",
]);

const STATUS_REQUEST_PHRASES = new Set([
    "status",
    "order status",
    "my order status",
    "show order status",
    "show my order status",
    "check order status",
    "what s my order status",
    "what is my order status",
    "status of my order",
    "where is my order",
    "where s my order",
    "track order",
    "track my order",
    "payment status",
    "my payment status",
]);

const HELP_REQUEST_PHRASES = new Set([
    "help",
    "start",
    "how does this work",
    "how do i order",
    "how can i order",
]);

const STORE_INFO_PHRASES = new Set([
    // location
    "address",
    "your address",
    "where are you",
    "where are you located",
    "where is the restaurant",
    "where is the store",
    "location",
    "your location",
    // hours
    "hours",
    "your hours",
    "opening hours",
    "business hours",
    "what are your hours",
    "when do you open",
    "when do you close",
    "what time do you open",
    "what time do you close",
    "what time do you close today",
    "closing time",
    "opening time",
    // open status
    "are you open",
    "are you open now",
    "are you currently open",
    "is the store open",
    "is the restaurant open",
    "are you closed",
    "is the store closed",
]);

function isStoreInfoRequest(normalized: string): boolean {
    if (STORE_INFO_PHRASES.has(normalized)) return true;
    if (/\b(address|location|directions)\b/.test(normalized) && /\b(your|the store|restaurant|you)\b/.test(normalized)) return true;
    if (/\b(hours?|open|close|closing|closing time|open now)\b/.test(normalized) && /\b(when|what time|are you|is the)\b/.test(normalized)) return true;
    return false;
}

const GREETING_PHRASES = new Set([
    "hi",
    "hello",
    "hey",
    "good morning",
    "good afternoon",
    "good evening",
]);

const MATCH_STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "for",
    "from",
    "get",
    "have",
    "i",
    "in",
    "is",
    "it",
    "like",
    "me",
    "my",
    "of",
    "on",
    "or",
    "please",
    "show",
    "that",
    "the",
    "this",
    "to",
    "want",
    "what",
    "with",
    "without",
    "you",
]);

function tokenizeMatchTerms(text: string): string[] {
    return normalizeIntentText(text)
        .split(" ")
        .filter((token) => token.length >= 2 && !MATCH_STOP_WORDS.has(token));
}

function generateOrderId(): string {
    return `${ORDER_ID_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeIntentText(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ");
}

function formatLogPayload(payload: unknown): string {
    try {
        return JSON.stringify(payload, null, 2);
    } catch {
        return String(payload);
    }
}

function deriveConversationStage(savedStage: string | undefined, cart: StoredCart): ConversationStage {
    if (savedStage === "shopping" || savedStage === "awaiting_order_confirmation" || savedStage === "submitted") {
        return savedStage;
    }

    return cart ? "awaiting_order_confirmation" : "shopping";
}

function buildCartContext(
    cart: StoredCart,
    stage: ConversationStage,
    pricing: StorePricingRecord
) {
    if (!cart) {
        return {
            hasActiveCart: false,
            orderId: null,
            items: [],
            subtotal: null,
            feeTotal: null,
            tax: null,
            total: null,
            fees: [],
            taxRate: pricing.taxRate,
            itemCount: 0,
        };
    }

    if (stage === "submitted") {
        return {
            hasActiveCart: false,
            orderId: null,
            items: [],
            subtotal: null,
            feeTotal: null,
            tax: null,
            total: null,
            fees: [],
            taxRate: pricing.taxRate,
            itemCount: 0,
        };
    }

    const items = normalizeStoredCartLines(cart.items);
    const summary = calculateOrderPricing(items, pricing);
    return {
        hasActiveCart: true,
        orderId: cart.orderId,
        items,
        subtotal: summary.subtotal,
        feeTotal: summary.feeTotal,
        tax: summary.tax,
        total: summary.total,
        fees: summary.fees,
        taxRate: summary.taxRate,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    };
}

function formatStatusLabel(value: string): string {
    return value.replace(/_/g, " ");
}

function buildClosedStoreNotice(hasActiveCart: boolean): string {
    return hasActiveCart
        ? "*Store is currently closed.* You can keep editing this cart and reply confirm to queue a prepaid order for when the store reopens."
        : "*Store is currently closed.* You can still browse the menu and build a cart now. When you're ready, reply confirm to queue a prepaid order for when the store reopens.";
}

function appendClosedStoreNotice(message: string, hasActiveCart: boolean): string {
    return [message, "", buildClosedStoreNotice(hasActiveCart)].join("\n");
}

/**
 * Formats store location, hours, and open status into a compact WhatsApp-friendly message.
 * Renders fresh — always called at execution time so isOpen reflects the current state.
 */
function formatStoreInfoReply(store: StoreWithMenu): string {
    const lines: string[] = [];
    lines.push(`🛎️ ${store.name}`);
    lines.push(`📍 ${store.address}`);

    // Format hours: keys are camelCase day ranges (e.g. sunThu, friSat), values are 24h ranges
    const hourLines = Object.entries(store.hours).map(([dayRange, range]) => {
        const label = dayRange
            .replace(/([A-Z])/g, "–$1")
            .replace(/^([a-z])/, (c) => c.toUpperCase());
        const [start, end] = range.split("-");
        const fmt = (t: string) => {
            const [h, m] = t.split(":").map(Number);
            const hrs = h % 24;
            const mins = (m ?? 0);
            const period = hrs < 12 ? "AM" : "PM";
            const displayHr = hrs === 0 ? 12 : hrs > 12 ? hrs - 12 : hrs;
            return mins > 0 ? `${displayHr}:${String(mins).padStart(2, "0")}${period}` : `${displayHr}${period}`;
        };
        return `  ${label}: ${fmt(start)} – ${fmt(end)}`;
    });
    lines.push(`🕐 Hours:\n${hourLines.join("\n")}`);

    lines.push(store.settings.isOpen ? "🟢 We're open now!" : "🔴 Currently closed.");

    return lines.join("\n");
}

/**
 * Unified status reply: shows the active draft cart (if any) followed by up to 2 active
 * submitted orders (completed and cancelled are excluded at the DB query level).
 * Used by both the deterministic short-circuit and the show_status planner type.
 */
function formatStatusReply(
    cartContext: ReturnType<typeof buildCartContext>,
    recentOrders: OrderSummaryRecord[]
): string {
    const sections: string[] = [];

    if (cartContext.hasActiveCart) {
        sections.push(formatCartSummary({
            orderId: cartContext.orderId,
            items: cartContext.items,
            itemCount: cartContext.itemCount,
            lineCount: cartContext.items.length,
            subtotal: cartContext.subtotal ?? 0,
            feeTotal: cartContext.feeTotal ?? 0,
            tax: cartContext.tax ?? 0,
            total: cartContext.total ?? 0,
            taxRate: cartContext.taxRate,
            fees: cartContext.fees,
            currency: DEFAULT_CURRENCY,
        }));
    }

    if (recentOrders.length > 0) {
        if (sections.length > 0) sections.push("");
        sections.push(
            "Recent orders:",
            ...recentOrders.map((order) =>
                `- ${order.id}: ${formatStatusLabel(order.status)}, payment ${formatStatusLabel(order.paymentStatus)}, ${order.itemCount} item(s), $${order.total.toFixed(2)}`
            )
        );
    }

    if (sections.length === 0) {
        return [
            "No active cart or recent orders.",
            "- Reply menu to browse items.",
            "- Or send an item name and quantity to start an order.",
        ].join("\n");
    }

    return sections.join("\n");
}

function normalizeSelectionPairs(selections: Array<{ optionId: string; choiceId: string }>): Array<{ optionId: string; choiceId: string }> {
    return [...selections]
        .map((selection) => ({ optionId: selection.optionId, choiceId: selection.choiceId }))
        .sort((left, right) => left.optionId.localeCompare(right.optionId));
}

function areSelectionPairsEqual(
    left: Array<{ optionId: string; choiceId: string }>,
    right: Array<{ optionId: string; choiceId: string }>
): boolean {
    if (left.length !== right.length) {
        return false;
    }

    const normalizedLeft = normalizeSelectionPairs(left);
    const normalizedRight = normalizeSelectionPairs(right);

    return normalizedLeft.every((selection, index) =>
        selection.optionId === normalizedRight[index].optionId
        && selection.choiceId === normalizedRight[index].choiceId
    );
}

function countSharedTerms(left: string[], right: string[]): number {
    const rightSet = new Set(right);
    return left.reduce((count, term) => count + (rightSet.has(term) ? 1 : 0), 0);
}

function userExplicitlyRequestsSameItem(normalizedText: string): boolean {
    return [
        "same",
        "same one",
        "same thing",
        "same as before",
        "like before",
        "like that",
        "just like that",
    ].some((phrase) => normalizedText.includes(phrase));
}

function userExplicitlyMentionsItem(normalizedText: string, itemName: string): boolean {
    const messageTerms = tokenizeMatchTerms(normalizedText);
    const itemTerms = tokenizeMatchTerms(itemName);

    if (itemTerms.length === 0 || messageTerms.length === 0) {
        return false;
    }

    const sharedTerms = countSharedTerms(itemTerms, messageTerms);
    return sharedTerms >= Math.min(2, itemTerms.length);
}

function userExplicitlyMentionsAddOn(normalizedText: string, addOnName: string): boolean {
    if (normalizedText.includes(normalizeIntentText(addOnName))) {
        return true;
    }

    const messageTerms = tokenizeMatchTerms(normalizedText);
    const addOnTerms = tokenizeMatchTerms(addOnName);
    return countSharedTerms(addOnTerms, messageTerms) > 0;
}

function normalizePlannerCartActions(
    actions: CartActionInput[],
    currentItems: ReturnType<typeof normalizeStoredCartLines>,
    menu: StoreMenuRecord,
    text: string
): { actions: CartActionInput[]; changed: boolean } {
    let changed = false;
    const normalizedText = normalizeIntentText(text);

    const normalizedActions = actions.map((action) => {
        if (action.type === "add_item" && action.itemId && action.selectedAddOns.length > 0) {
            const menuEntry = menu.categories
                .flatMap((category) => category.items.map((item) => ({ category, item })))
                .find(({ item }) => item.id === action.itemId);

            if (
                menuEntry
                && userExplicitlyMentionsItem(normalizedText, menuEntry.item.name)
                && !userExplicitlyRequestsSameItem(normalizedText)
            ) {
                const explicitlyRequestedAddOns = getMenuItemAddOns(menuEntry.category, menuEntry.item)
                    .filter((addOn) => userExplicitlyMentionsAddOn(normalizedText, addOn.name))
                    .map((addOn) => addOn.id);
                const normalizedSelectedAddOns = action.selectedAddOns.filter((addOnId) =>
                    explicitlyRequestedAddOns.includes(addOnId)
                );

                if (normalizedSelectedAddOns.length !== action.selectedAddOns.length) {
                    changed = true;
                    return {
                        ...action,
                        selectedAddOns: normalizedSelectedAddOns,
                    };
                }
            }
        }

        if (action.type !== "update_item" || !action.lineId) {
            return action;
        }

        const currentLine = currentItems.find((item) => item.lineId === action.lineId);
        if (!currentLine) {
            return action;
        }

        let nextAction = action;
        const currentSelections = extractStoredOptionSelections(currentLine.selectedOptions);
        if (
            action.selectedOptions.length === 0
            && action.targetSelectedOptions.length > 0
            && !areSelectionPairsEqual(currentSelections, action.targetSelectedOptions)
        ) {
            changed = true;
            nextAction = {
                ...nextAction,
                selectedOptions: action.targetSelectedOptions,
                targetSelectedOptions: currentSelections,
            };
        }

        const currentAddOns = extractStoredAddOnIds(currentLine.selectedOptions);
        const normalizedCurrentAddOns = [...currentAddOns].sort((left, right) => left.localeCompare(right));
        const normalizedTargetAddOns = [...action.targetSelectedAddOns].sort((left, right) => left.localeCompare(right));
        if (
            action.selectedAddOns.length === 0
            && action.targetSelectedAddOns.length > 0
            && (
                normalizedCurrentAddOns.length !== normalizedTargetAddOns.length
                || normalizedCurrentAddOns.some((addOnId, index) => addOnId !== normalizedTargetAddOns[index])
            )
        ) {
            changed = true;
            nextAction = {
                ...nextAction,
                selectedAddOns: action.targetSelectedAddOns,
                targetSelectedAddOns: currentAddOns,
            };
        }

        return nextAction;
    });

    return { actions: normalizedActions, changed };
}

function buildClarificationReply(question: string, suggestions: string[]): string {
    if (suggestions.length === 0) {
        return [
            question,
            "",
            "- You can reply with an item name and quantity, or reply menu to browse the menu.",
        ].join("\n");
    }

    return [
        question,
        "",
        "Options:",
        ...suggestions.map((suggestion) => `- ${suggestion}`),
        "- You can also reply menu to browse the full menu.",
    ].join("\n");
}

function formatSubmitOrderReply(result: SubmitOrderResult): string {
    return [
        result.message,
        `Order ID: ${result.orderId}`,
        `Payment link: ${result.paymentLink}`,
        ...(result.queuedForOpen
            ? [
                "*Store is currently closed.* Your prepaid order will stay queued and be processed after the store reopens.",
                "- Next step: open the payment link to complete checkout and hold your place in the queue.",
                "- We will send order updates here after payment and again when the store starts processing the order.",
            ]
            : [
                "- Next step: open the payment link to complete checkout.",
                "- We will send order updates here after payment.",
            ]),
    ].join("\n");
}

function shouldDeterministicallySubmit(text: string, stage: ConversationStage): boolean {
    const normalized = normalizeIntentText(text);

    if (DIRECT_SUBMIT_PHRASES.has(normalized)) {
        return true;
    }

    return stage === "awaiting_order_confirmation" && AWAITING_CONFIRMATION_PHRASES.has(normalized);
}

function textReply(text: string): OutboundReply {
    return { kind: "text", text };
}

function menuBrowseReply(menu: StoreMenuRecord, includeClosedStoreNotice: boolean, hasActiveCart: boolean): OutboundReply {
    return {
        kind: "menu_browse",
        menu,
        includeClosedStoreNotice,
        hasActiveCart,
    };
}

function buildHelpReply(): string {
    return [
        "You can order by sending item names with quantity and options.",
        "- Reply menu to browse the menu.",
        "- Reply cart to review your current cart.",
        "- Reply status to check your draft or submitted orders.",
        "- Reply confirm when you're ready to submit the order.",
        "- Example: \"1 item name\" or \"2 item names\".",
    ].join("\n");
}

function buildStoreClosedReply(store: StoreWithMenu): string {
    return [
        `${store.name} is currently closed.`,
        "- You can still browse the menu and build your cart now.",
        "- When you're ready, reply confirm to queue a prepaid order for when the store reopens.",
    ].join("\n");
}

function buildDeterministicPlan(input: {
    text: string;
    stage: ConversationStage;
    store: StoreWithMenu;
    cartContext: ReturnType<typeof buildCartContext>;
}): PlannerResponse | ExecutionResult | null {
    if (shouldDeterministicallySubmit(input.text, input.stage)) {
        return { type: "submit_order" };
    }

    const normalized = normalizeIntentText(input.text);

    if (isMenuBrowseRequest(normalized)) {
        return {
            reply: menuBrowseReply(
                input.store.menu,
                !input.store.settings.isOpen,
                input.cartContext.hasActiveCart
            ),
            nextStage: input.stage,
        };
    }

    if (CART_REQUEST_PHRASES.has(normalized)) {
        return { type: "show_status" };
    }

    if (STATUS_REQUEST_PHRASES.has(normalized)) {
        return { type: "show_status" };
    }

    if (isStoreInfoRequest(normalized)) {
        return { type: "show_store_info" };
    }

    if (HELP_REQUEST_PHRASES.has(normalized)) {
        return {
            type: "respond",
            message: input.store.settings.isOpen
                ? buildHelpReply()
                : appendClosedStoreNotice(buildHelpReply(), input.cartContext.hasActiveCart),
        };
    }

    if (GREETING_PHRASES.has(normalized)) {
        const greetingReply = "Hi! Reply menu to browse items, or send an item name with quantity to start an order.\n- Example: \"1 item name\"\n- Reply cart any time to review your draft order.";
        return {
            type: "respond",
            message: input.store.settings.isOpen
                ? greetingReply
                : appendClosedStoreNotice(greetingReply, input.cartContext.hasActiveCart),
        };
    }

    return null;
}

async function saveAssistantReply(
    channelIdentifier: string,
    customerPhone: string,
    text: string,
    assistantReply: string,
    telemetry: MessageTelemetry,
    stage: ConversationStage,
    storeId: number,
    storeName: string,
    conversationId?: string
): Promise<void> {
    await telemetry.measure("stateSaveMs", async () => {
        const now = new Date();
        await saveConversation(channelIdentifier, customerPhone, {
            stage,
            conversationId,
            lastActivity: now,
        });
    });

    // Archive this turn to Blob Storage — fire-and-forget so a blob failure never
    // blocks the customer reply. The archive is the permanent record.
    appendConversationTurn(channelIdentifier, customerPhone, {
        ts: new Date().toISOString(),
        storeId,
        storeName,
        channelIdentifier,
        stage,
        user: text,
        assistant: assistantReply,
    }).catch((err) => console.error("[conversationArchive] append failed", getErrorDetails(err)));
}

async function submitPendingOrder(tc: ToolContext): Promise<SubmitOrderResult> {
    const { storeId, storeSlug, storeName, storeIsOpen, channel, customerPhone, customerName, channelIdentifier, invocationContext: context } = tc;

    const cartEntry = tc.currentCart;
    if (!cartEntry) {
        throw new Error(`Active cart not found for ${channelIdentifier}/${customerPhone}`);
    }

    context.log(`Submitting active order: ${cartEntry.orderId}`);

    const existingOrder = await getOrderCheckoutStateById(cartEntry.orderId, storeId);
    if (existingOrder?.checkoutUrl && existingOrder.paymentStatus !== "paid") {
        context.log(`Order ${cartEntry.orderId} already persisted. Reusing checkout session.`);
        await deleteCart(channelIdentifier, customerPhone);
        tc.currentCart = null;
        const queuedForOpen = existingOrder.orderStatus === "queued_for_open";
        return {
            orderId: existingOrder.id,
            paymentLink: existingOrder.checkoutUrl,
            message: queuedForOpen
                ? "Order already queued for the next opening. Please complete payment."
                : "Order already submitted. Please complete payment.",
            queuedForOpen,
        };
    }

    const orderItems = toOrderItems(normalizeStoredCartLines(cartEntry.items));
    const { subtotal, feeTotal, tax, total } = calculateOrderPricing(orderItems, tc.pricing);

    const productName = `Order ${cartEntry.orderId} at ${cartEntry.storeName}`;
    const productDescription = `Order details: ${orderItems.map((item) => {
        const options = item.selectedOptions.map(formatStoredSelectionLabel).join(", ");
        return `${item.quantity}x ${item.itemName}${options ? ` (${options})` : ""}`;
    }).join(", ")}, Total: ${total} ${DEFAULT_CURRENCY}`;
    const queuedForOpen = !storeIsOpen;

    if (!existingOrder) {
        await createOrder({
            id: cartEntry.orderId,
            storeId,
            storeName,
            fulfillmentType: "pickup",
            channel,
            channelIdentifier,
            customerPhone,
            customerName,
            items: orderItems,
            subtotal,
            feeTotal,
            tax,
            total,
            currency: DEFAULT_CURRENCY,
            initialStatus: queuedForOpen ? "queued_for_open" : "new",
            initialStatusNote: queuedForOpen
                ? "Order queued while store was closed"
                : "Order created",
        });

        context.log(`Order ${cartEntry.orderId} persisted with pending payment state. queuedForOpen=${queuedForOpen}`);
    }

    const checkoutSession = await createCheckoutSession({
        orderId: cartEntry.orderId,
        storeId: cartEntry.storeId,
        storeSlug,
        productName,
        productDescription,
        total,
        currency: DEFAULT_CURRENCY,
    });

    await attachStripeCheckoutSession({
        orderId: cartEntry.orderId,
        stripeCheckoutSessionId: checkoutSession.id,
        checkoutUrl: checkoutSession.url,
    });

    context.log(`Order ${cartEntry.orderId} checkout session created: ${checkoutSession.id}`);
    await deleteCart(channelIdentifier, customerPhone);
    tc.currentCart = null;

    trackEvent("order_submitted", {
        storeId: tc.storeId,
        storeSlug: tc.storeSlug,
        channel: tc.channel,
        orderId: cartEntry.orderId,
        total,
        queuedForOpen,
    });

    return {
        orderId: cartEntry.orderId,
        paymentLink: checkoutSession.url,
        message: queuedForOpen
            ? "Order queued for the next opening. Please complete payment."
            : "Order submitted. Please complete payment.",
        queuedForOpen,
    };
}

async function applyCartMutation(
    tc: ToolContext,
    actions: CartActionInput[],
    currentStage: ConversationStage,
    text: string
): Promise<ApplyCartActionsResult> {
    const { cacheKey, storeId, storeName, channelIdentifier, customerPhone, invocationContext: context, menu } = tc;

    context.log(`applyCartActions — store: ${storeId}, cacheKey: ${cacheKey}`);
    const existing = currentStage === "submitted" ? null : tc.currentCart;
    const isNewCart = currentStage === "submitted";
    const orderId = isNewCart
        ? generateOrderId()
        : existing?.orderId ?? generateOrderId();
    const currentItems = isNewCart || !existing
        ? []
        : normalizeStoredCartLines(existing.items);
    const parsedActions = cartActionsSchema.parse(actions) as CartActionInput[];
    const normalizedActionResult = normalizePlannerCartActions(parsedActions, currentItems, menu, text);
    const effectiveActions = normalizedActionResult.actions;

    if (normalizedActionResult.changed) {
        context.log(`Normalized planner cart actions (${effectiveActions.length} actions): ${effectiveActions.map(a => a.type).join(", ")}`);
    }

    if (process.env.DEBUG_LOGGING === "true") {
        context.log(`[debug] applyCartActions input:\n${formatLogPayload({
            cacheKey,
            currentStage,
            existingOrderId: existing?.orderId ?? null,
            nextOrderId: orderId,
            currentItems,
            actions: effectiveActions,
        })}`);
    }

    const result = applyCartActions({
        currentItems,
        actions: effectiveActions,
        menu,
        pricing: tc.pricing,
        orderId,
    });

    context.log(`applyCartActions result: orderId=${result.orderId}, items=${result.itemCount}, total=${result.total}`);
    if (process.env.DEBUG_LOGGING === "true") {
        context.log(`[debug] applyCartActions result:\n${formatLogPayload({
            orderId: result.orderId,
            itemCount: result.itemCount,
            lineCount: result.lineCount,
            subtotal: result.subtotal,
            tax: result.tax,
            total: result.total,
            items: result.items,
            summaryText: result.summaryText,
        })}`);
    }

    if (result.items.length === 0) {
        await deleteCart(channelIdentifier, customerPhone);
        tc.currentCart = null;
        return result;
    }

    const nextCart = {
        storeId: storeId.toString(),
        storeName,
        orderId: result.orderId ?? orderId,
        items: result.items,
        subtotal: result.subtotal,
        feeTotal: result.feeTotal,
        taxRate: result.taxRate,
        tax: result.tax,
        total: result.total,
        lastActivity: new Date(),
    };

    await saveCart(channelIdentifier, customerPhone, nextCart);
    tc.currentCart = nextCart;

    trackEvent("cart_updated", {
        storeId: tc.storeId,
        channel: tc.channel,
        orderId: nextCart.orderId,
        itemCount: result.itemCount,
        total: result.total,
    });

    return result;
}



async function planNextStep(input: {
    text: string;
    stage: ConversationStage;
    store: StoreWithMenu;
    cartContext: ReturnType<typeof buildCartContext>;
    telemetry: MessageTelemetry;
    context: InvocationContext;
    channel: string;
    channelIdentifier: string;
    customerPhone: string;
    conversationId?: string;
}): Promise<(PlannerResponse | ExecutionResult) & { conversationId?: string }> {
    const deterministicPlan = buildDeterministicPlan({
        text: input.text,
        stage: input.stage,
        store: input.store,
        cartContext: input.cartContext,
    });

    if (deterministicPlan) {
        input.context.log(`Deterministic plan selected: ${"type" in deterministicPlan ? deterministicPlan.type : deterministicPlan.reply.kind}`);
        return deterministicPlan;
    }

    // Gateway: normalize message and choose model tier (fast or smart). Zero network calls.
    const { normalizedMessage, modelTier } = processMessage(input.text);

    // State snapshot — always fresh, inline. storeIsOpen included for context.
    const stateSnapshot = `Stage: ${input.stage}. Store: ${input.store.settings.isOpen ? "open" : "closed"}. Cart: ${
        input.cartContext.hasActiveCart
            ? `${input.cartContext.itemCount} item(s), $${input.cartContext.total.toFixed(2)}`
            : "empty"
    }.`;

    // Per-request tools with request-scoped context injected
    const tools = [
        makeSearchMenuTool(input.store.id),
        makeGetCartTool(input.channel, input.channelIdentifier, input.customerPhone),
    ];

    // Build typed LLM input: turn 1 seeds the thread, turn 2+ uses conversationId
    const llmInput = input.conversationId
        ? { conversationId: input.conversationId, stateSnapshot, userMessage: normalizedMessage }
        : {
            systemPrompt: PLANNER_SYSTEM_PROMPT,
            menuContext: buildCompactMenuContext(input.store.menu),
            stateSnapshot,
            userMessage: normalizedMessage,
        };

    const llmStartedAt = Date.now();
    let llmSuccess = false;
    let llmOutput: Awaited<ReturnType<typeof callNano>>;
    const selectedModel = modelTier === "fast" ? getEnvironmentConfig().openai.model : getEnvironmentConfig().openai.smartModel;

    try {
        llmOutput = await input.telemetry.measure("agentRunMs", () =>
            modelTier === "fast"
                ? callNano(llmInput, tools)
                : callMini(llmInput, tools)
        );
        llmSuccess = true;
    } finally {
        trackDependency({
            name: "OpenAI Planner",
            dependencyTypeName: "HTTP",
            data: selectedModel,
            duration: Date.now() - llmStartedAt,
            success: llmSuccess,
            properties: {
                model: selectedModel,
                modelTier,
                stage: input.stage,
                isNewConversation: String(!input.conversationId),
            },
        });
    }

    input.context.log(`Planner output:\n${formatLogPayload(llmOutput.plan)}`);
    return { ...llmOutput.plan, conversationId: llmOutput.conversationId };
}

async function executePlan(input: {
    plan: PlannerResponse;
    stage: ConversationStage;
    text: string;
    toolContext: ToolContext;
    cartContext: ReturnType<typeof buildCartContext>;
}): Promise<ExecutionResult> {
    switch (input.plan.type) {
        case "respond":
            return {
                reply: textReply(input.plan.message.trim()),
                nextStage: input.stage,
            };
        case "ask_clarification":
            return {
                reply: textReply(buildClarificationReply(input.plan.question, input.plan.suggestions)),
                nextStage: input.stage,
            };
        case "show_status": {
            const recentOrders = await listRecentOrderSummariesByCustomer({
                channel: input.toolContext.channel,
                channelIdentifier: input.toolContext.channelIdentifier,
                customerPhone: input.toolContext.customerPhone,
                limit: RECENT_ORDER_CONTEXT_LIMIT,
            });
            const reply = formatStatusReply(input.cartContext, recentOrders);
            return {
                reply: textReply(
                    input.toolContext.storeIsOpen
                        ? reply
                        : appendClosedStoreNotice(reply, input.cartContext.hasActiveCart)
                ),
                nextStage: input.stage,
            };
        }
        case "show_store_info":
            return {
                reply: textReply(formatStoreInfoReply(input.toolContext.store)),
                nextStage: input.stage,
            };
        case "cart_mutation": {
            let result: ApplyCartActionsResult;
            try {
                result = await applyCartMutation(input.toolContext, input.plan.actions, input.stage, input.text);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                // Unknown item/option IDs mean the model hallucinated catalog IDs. Return a
                // user-safe message so the customer can retry rather than crashing the workflow.
                if (
                    msg.includes("not found") ||
                    msg.includes("Unknown add-ons") ||
                    msg.includes("Invalid choice")
                ) {
                    return {
                        reply: textReply("Sorry, I couldn't find one of the items you requested. Could you try rephrasing or let me know what you'd like to order?"),
                        nextStage: input.stage,
                    };
                }
                throw err;
            }
            return {
                reply: textReply(!input.toolContext.storeIsOpen && result.items.length > 0
                    ? appendClosedStoreNotice(result.summaryText, true)
                    : result.summaryText),
                nextStage: result.items.length > 0 ? "awaiting_order_confirmation" : "shopping",
            };
        }
        case "submit_order": {
            const submitResult = await submitPendingOrder(input.toolContext);
            return {
                reply: textReply(formatSubmitOrderReply(submitResult)),
                nextStage: "submitted",
            };
        }
    }
}

export const runWorkflow = async (workflow: WorkflowInput): Promise<{ reply: OutboundReply }> => {
    const { text, channel, customerPhone, customerName, channelIdentifier, context, telemetry, store: prefetchedStore } = workflow;
    const cacheKey = `${customerPhone}_${channelIdentifier}`;

    return await withTrace("OmniOrder AI Planner", async () => {
        const prepStartedAt = Date.now();

        const [store, saved, cart] = await Promise.all([
            prefetchedStore
                ? Promise.resolve(prefetchedStore)
                : getStoreWithMenuByChannelIdentifier(channel, channelIdentifier),
            getConversation(channelIdentifier, customerPhone),
            getCart(channelIdentifier, customerPhone),
        ]);

        if (!store) {
            throw new Error(`Store catalog not found for channel ${channel} and identifier ${channelIdentifier}`);
        }

        context.log(`Store resolved: ${store.name} (id=${store.id})`);
        const stage = deriveConversationStage(saved?.stage, cart);
        const cartContext = buildCartContext(cart, stage, store.pricing);
        const toolContext: ToolContext = {
            cacheKey,
            storeId: store.id,
            storeSlug: store.slug,
            storeName: store.name,
            storeIsOpen: store.settings.isOpen,
            channel,
            customerPhone,
            customerName,
            channelIdentifier,
            pricing: store.pricing,
            invocationContext: context,
            menu: store.menu,
            currentCart: cart,
            store,
        };

        telemetry.record("agentPrepMs", Date.now() - prepStartedAt);
        telemetry.record("conversationStage", stage);
        context.log(saved ? `Resuming conversation for: ${cacheKey}` : `Starting new conversation for: ${cacheKey}`);

        try {
            const planResult = await planNextStep({
                text,
                stage,
                store,
                cartContext,
                telemetry,
                context,
                channel,
                channelIdentifier,
                customerPhone,
                conversationId: saved?.conversationId,
            });
            const { conversationId: newConversationId, ...plan } = planResult;

            // Save new conversationId on turn 1 (LLM turn only — deterministic paths don't create one)
            const effectiveConversationId = newConversationId ?? saved?.conversationId;
            if (newConversationId && !saved?.conversationId) {
                await saveConversationId(channelIdentifier, customerPhone, newConversationId);
                context.log(`New conversation threaded: ${newConversationId.slice(0, 16)}…`);
            }

            const execution = "reply" in plan
                ? plan
                : await executePlan({
                    plan,
                    stage,
                    text,
                    toolContext,
                    cartContext,
                });
            const persistedReply = renderOutboundReply(execution.reply);

            // Save runs in the background — not on the customer-facing critical path.
            // The reply is returned immediately; save completes while the worker sends to WhatsApp.
            saveAssistantReply(
                channelIdentifier,
                customerPhone,
                text,
                persistedReply,
                telemetry,
                execution.nextStage,
                store.id,
                store.name,
                effectiveConversationId
            ).then(() => {
                context.log(`Conversation saved for: ${cacheKey}, stage: ${execution.nextStage}${effectiveConversationId ? `, conversationId: ${effectiveConversationId.slice(0, 16)}…` : ""}`);
            }).catch((err: unknown) => {
                context.error("Failed to save conversation after reply", { cacheKey, error: getErrorDetails(err) });
            });

            return { reply: execution.reply };
        } catch (error) {
            context.error("runWorkflow failed", {
                cacheKey,
                stage,
                error: getErrorDetails(error),
            });
            throw error;
        }
    }, { groupId: cacheKey, metadata: { channel, channelIdentifier } });
};
