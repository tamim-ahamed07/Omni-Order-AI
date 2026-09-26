import { z } from "zod";
import { DEFAULT_CURRENCY } from "../config/constants";
import { getEnvironmentConfig } from "../config/environment";
import {
    getMenuItemAddOns,
    getMenuItemOptions,
    MenuAddOnRecord,
    StoreMenuRecord,
    StorePricingRecord,
} from "../shared/defaultCatalog";
import { calculateOrderPricing, AppliedStoreFee } from "../shared/pricing";
import { OrderItemInput, SelectedOptionInput } from "../shared/sqlClient";

export interface CartLine extends OrderItemInput {
    lineId: string;
}

export interface CartSummary {
    orderId: string | null;
    items: CartLine[];
    itemCount: number;
    lineCount: number;
    subtotal: number;
    feeTotal: number;
    tax: number;
    total: number;
    taxRate: number;
    fees: AppliedStoreFee[];
    currency: string;
}

export interface ApplyCartActionsResult extends CartSummary {
    summaryText: string;
}

export const requestedSelectedOptionSchema = z.object({
    optionId: z.string(),
    choiceId: z.string(),
});

export type RequestedSelectedOptionInput = z.infer<typeof requestedSelectedOptionSchema>;
export type RequestedSelectedAddOnInput = string;

export const requestedOrderItemSchema = z.object({
    itemId: z.string(),
    quantity: z.number().int().positive().default(1),
    selectedOptions: z.array(requestedSelectedOptionSchema).default([]),
    selectedAddOns: z.array(z.string()).default([]),
});

export type RequestedOrderItemInput = z.infer<typeof requestedOrderItemSchema>;

const storedSelectedOptionSchema = z.object({
    optionId: z.string(),
    optionName: z.string().optional(),
    choiceId: z.string(),
    choiceName: z.string().optional(),
    choicePrice: z.number(),
});

export const storedCartLineSchema = z.object({
    lineId: z.string().optional(),
    itemId: z.string(),
    itemName: z.string(),
    quantity: z.number().int().positive(),
    price: z.number(),
    selectedOptions: z.array(storedSelectedOptionSchema),
});

const cartActionTypeSchema = z.enum(["add_item", "update_item", "remove_item", "clear_cart"]);

export const cartActionSchema = z.object({
    type: cartActionTypeSchema,
    lineId: z.string().nullable().default(null),
    itemId: z.string().nullable().default(null),
    quantity: z.number().int().positive().nullable().default(null),
    selectedOptions: z.array(requestedSelectedOptionSchema).default([]),
    selectedAddOns: z.array(z.string()).default([]),
    targetSelectedOptions: z.array(requestedSelectedOptionSchema).default([]),
    targetSelectedAddOns: z.array(z.string()).default([]),
});

export const cartActionsSchema = z.array(cartActionSchema).min(1);

export type CartActionInput = z.infer<typeof cartActionSchema>;
export const requestedOrderItemsSchema = z.array(requestedOrderItemSchema);

const ADD_ON_SELECTION_PREFIX = "add_on::";

function generateLineId(): string {
    return `line_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getAddOnSelectionOptionId(addOnId: string): string {
    return `${ADD_ON_SELECTION_PREFIX}${addOnId}`;
}

function isAddOnSelection(selection: Pick<SelectedOptionInput, "optionId">): boolean {
    return selection.optionId.startsWith(ADD_ON_SELECTION_PREFIX);
}

function cloneSelectedOption(option: SelectedOptionInput): SelectedOptionInput {
    return { ...option };
}

function cloneCartLine(item: CartLine): CartLine {
    return {
        ...item,
        selectedOptions: item.selectedOptions.map(cloneSelectedOption),
    };
}

function getCartLineKey(item: { itemId: string; selectedOptions: Array<{ optionId: string; choiceId: string }> }): string {
    const selections = [...item.selectedOptions]
        .sort((left, right) => left.optionId.localeCompare(right.optionId))
        .map((option) => `${option.optionId}:${option.choiceId}`)
        .join("|");

    return `${item.itemId}::${selections}`;
}

export function extractStoredOptionSelections(
    selections: SelectedOptionInput[]
): RequestedSelectedOptionInput[] {
    return selections
        .filter((selection) => !isAddOnSelection(selection))
        .map((selection) => ({
            optionId: selection.optionId,
            choiceId: selection.choiceId,
        }));
}

export function extractStoredAddOnIds(
    selections: SelectedOptionInput[]
): RequestedSelectedAddOnInput[] {
    return selections
        .filter((selection) => isAddOnSelection(selection))
        .map((selection) => selection.choiceId)
        .sort((left, right) => left.localeCompare(right));
}

export function formatStoredSelectionLabel(selection: SelectedOptionInput): string {
    if (selection.optionName && selection.choiceName) {
        return `${selection.optionName}: ${selection.choiceName}`;
    }

    return selection.choiceName ?? selection.choiceId;
}

export function calculateCartTotals(
    items: Array<{ price: number; quantity: number; selectedOptions: Array<{ choicePrice: number }> }>,
    pricing: StorePricingRecord
) {
    return calculateOrderPricing(items, pricing);
}

function getMenuItems(menu: StoreMenuRecord) {
    return menu.categories.flatMap((category) => category.items);
}

function getMenuItemById(menu: StoreMenuRecord, itemId: string) {
    for (const category of menu.categories) {
        const item = category.items.find((candidate) => candidate.id === itemId);
        if (item) {
            return { category, item };
        }
    }

    return null;
}

function enrichSelectedOptions(
    options: ReturnType<typeof getMenuItemOptions>,
    selectedOptions: RequestedSelectedOptionInput[]
): SelectedOptionInput[] {
    // Resolve selections that may reference option/choice by name or by id.
    const resolvedSelections = new Map<string, string>();

    for (const selectedOption of selectedOptions) {
        // Try to resolve option by id first, then by name
        const matchedOption = options.find((o) => o.id === selectedOption.optionId) ?? options.find((o) => o.name === selectedOption.optionId);
        const optionId = matchedOption ? matchedOption.id : selectedOption.optionId;

        if (resolvedSelections.has(optionId)) {
            throw new Error(`Duplicate selection for option ${selectedOption.optionId}`);
        }

        resolvedSelections.set(optionId, selectedOption.choiceId);
    }

    const enrichedOptions: SelectedOptionInput[] = [];

    for (const option of options) {
        const selectedChoiceRaw = resolvedSelections.get(option.id);

        let choice = undefined;
        if (selectedChoiceRaw) {
            // Allow choice to be referenced by id or by name
            choice = option.choices.find((candidate) => candidate.id === selectedChoiceRaw) ?? option.choices.find((candidate) => candidate.name === selectedChoiceRaw);
            if (!choice) {
                throw new Error(`Invalid choice ${selectedChoiceRaw} for option ${option.id}`);
            }
        } else {
            // pick default if present
            choice = option.choices.find((candidate) => candidate.isDefault);
            if (!choice) {
                continue;
            }
        }

        enrichedOptions.push({
            optionId: option.id,
            optionName: option.name,
            choiceId: choice.id,
            choiceName: choice.name,
            choicePrice: choice.price,
        });

        resolvedSelections.delete(option.id);
    }

    if (resolvedSelections.size > 0) {
        throw new Error(`Unknown options selected: ${Array.from(resolvedSelections.keys()).join(", ")}`);
    }

    return enrichedOptions;
}

function normalizeRequestedAddOns(addOnIds: RequestedSelectedAddOnInput[]): RequestedSelectedAddOnInput[] {
    return Array.from(new Set(addOnIds.map((addOnId) => addOnId.trim()).filter((addOnId) => addOnId.length > 0)))
        .sort((left, right) => left.localeCompare(right));
}

function enrichSelectedAddOns(
    addOns: MenuAddOnRecord[],
    selectedAddOns: RequestedSelectedAddOnInput[]
): SelectedOptionInput[] {
    const selectedAddOnIds = new Set(normalizeRequestedAddOns(selectedAddOns));
    const enrichedAddOns: SelectedOptionInput[] = [];

    for (const addOn of addOns) {
        if (!selectedAddOnIds.has(addOn.id)) {
            continue;
        }

        enrichedAddOns.push({
            optionId: getAddOnSelectionOptionId(addOn.id),
            choiceId: addOn.id,
            choiceName: addOn.name,
            choicePrice: addOn.price,
        });
        selectedAddOnIds.delete(addOn.id);
    }

    if (selectedAddOnIds.size > 0) {
        throw new Error(`Unknown add-ons selected: ${Array.from(selectedAddOnIds.values()).join(", ")}`);
    }

    return enrichedAddOns;
}

function enrichRequestedItem(menu: StoreMenuRecord, item: RequestedOrderItemInput): OrderItemInput {
    const menuEntry = getMenuItemById(menu, item.itemId);
    if (!menuEntry) {
        throw new Error(`Menu item ${item.itemId} not found`);
    }
    if (menuEntry.item.isAvailable === false) {
        throw new Error(`Menu item ${menuEntry.item.name} is unavailable`);
    }

    const options = getMenuItemOptions(menuEntry.category, menuEntry.item);
    const addOns = getMenuItemAddOns(menuEntry.category, menuEntry.item);

    return {
        itemId: menuEntry.item.id,
        itemName: menuEntry.item.name,
        quantity: item.quantity,
        price: menuEntry.item.price,
        selectedOptions: [
            ...enrichSelectedOptions(options, item.selectedOptions),
            ...enrichSelectedAddOns(addOns, item.selectedAddOns),
        ],
    };
}

export function validateRequestedOrderItems(menu: StoreMenuRecord, items: RequestedOrderItemInput[]): OrderItemInput[] {
    return items.map((item) => enrichRequestedItem(menu, item));
}

function normalizeRequestedSelections(
    currentSelections: RequestedSelectedOptionInput[],
    nextSelections: RequestedSelectedOptionInput[]
): RequestedSelectedOptionInput[] {
    const merged = new Map<string, string>();

    for (const selection of currentSelections) {
        merged.set(selection.optionId, selection.choiceId);
    }

    for (const selection of nextSelections) {
        merged.set(selection.optionId, selection.choiceId);
    }

    return Array.from(merged.entries()).map(([optionId, choiceId]) => ({ optionId, choiceId }));
}

export function normalizeStoredCartLines(rawItems: unknown): CartLine[] {
    const parsedItems = z.array(storedCartLineSchema).parse(rawItems);

    return parsedItems.map((item, index) => ({
        lineId: item.lineId ?? `line_${index + 1}`,
        itemId: item.itemId,
        itemName: item.itemName,
        quantity: item.quantity,
        price: item.price,
        selectedOptions: item.selectedOptions.map((selection) => ({
            optionId: selection.optionId,
            optionName: selection.optionName,
            choiceId: selection.choiceId,
            choiceName: selection.choiceName,
            choicePrice: selection.choicePrice,
        })),
    }));
}

export function toOrderItems(lines: CartLine[]): OrderItemInput[] {
    return lines.map(({ lineId: _lineId, ...item }) => ({
        ...item,
        selectedOptions: item.selectedOptions.map(cloneSelectedOption),
    }));
}

function mergeEquivalentLines(lines: CartLine[]): CartLine[] {
    const merged: CartLine[] = [];
    const indexByKey = new Map<string, number>();

    for (const line of lines) {
        const key = getCartLineKey(line);
        const existingIndex = indexByKey.get(key);

        if (existingIndex === undefined) {
            merged.push(cloneCartLine(line));
            indexByKey.set(key, merged.length - 1);
            continue;
        }

        merged[existingIndex] = {
            ...merged[existingIndex],
            quantity: merged[existingIndex].quantity + line.quantity,
        };
    }

    return merged;
}

function findTargetLineIndex(
    lines: CartLine[],
    action: CartActionInput,
    menu: StoreMenuRecord
): number {
    if (action.lineId) {
        const index = lines.findIndex((line) => line.lineId === action.lineId);
        if (index === -1) {
            throw new Error(`Cart line ${action.lineId} not found`);
        }
        return index;
    }

    if (!action.itemId) {
        throw new Error(`Action ${action.type} requires itemId or lineId`);
    }

    let matches = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.itemId === action.itemId);

    if (action.targetSelectedOptions.length > 0 || action.targetSelectedAddOns.length > 0) {
        const menuEntry = getMenuItemById(menu, action.itemId);
        if (!menuEntry) {
            throw new Error(`Menu item ${action.itemId} not found`);
        }

        const targetKey = getCartLineKey({
            itemId: action.itemId,
            selectedOptions: [
                ...enrichSelectedOptions(
                    getMenuItemOptions(menuEntry.category, menuEntry.item),
                    action.targetSelectedOptions
                ),
                ...enrichSelectedAddOns(
                    getMenuItemAddOns(menuEntry.category, menuEntry.item),
                    action.targetSelectedAddOns
                ),
            ],
        });

        matches = matches.filter(({ line }) => getCartLineKey(line) === targetKey);
    }

    if (matches.length === 0) {
        throw new Error(`Cart does not contain matching item ${action.itemId}`);
    }

    if (matches.length > 1) {
        throw new Error(`Cart update for ${action.itemId} is ambiguous; target a specific cart line`);
    }

    return matches[0].index;
}

function applyAddItem(lines: CartLine[], action: CartActionInput, menu: StoreMenuRecord): CartLine[] {
    if (!action.itemId) {
        throw new Error("add_item requires itemId");
    }

    const config = getEnvironmentConfig().cart;
    const requestedQty = action.quantity ?? 1;
    if (requestedQty > config.maxItemQuantity) {
        throw new Error(`Maximum quantity per item is ${config.maxItemQuantity}`);
    }

    const enrichedItem = enrichRequestedItem(menu, {
        itemId: action.itemId,
        quantity: requestedQty,
        selectedOptions: action.selectedOptions,
        selectedAddOns: action.selectedAddOns,
    });

    const nextLines = [
        ...lines.map(cloneCartLine),
        {
            lineId: generateLineId(),
            ...enrichedItem,
        },
    ];

    const merged = mergeEquivalentLines(nextLines);

    const uniqueItems = new Set(merged.map((l) => l.itemId)).size;
    if (uniqueItems > config.maxUniqueItems) {
        throw new Error(`You can add up to ${config.maxUniqueItems} different items per order`);
    }

    return merged;
}

function applyRemoveItem(lines: CartLine[], action: CartActionInput, menu: StoreMenuRecord): CartLine[] {
    const targetIndex = findTargetLineIndex(lines, action, menu);
    const nextLines = lines.map(cloneCartLine);
    const targetLine = nextLines[targetIndex];
    const quantityToRemove = action.quantity ?? targetLine.quantity;

    if (quantityToRemove > targetLine.quantity) {
        throw new Error(`Cannot remove ${quantityToRemove} item(s) from line ${targetLine.lineId}`);
    }

    if (quantityToRemove === targetLine.quantity) {
        nextLines.splice(targetIndex, 1);
        return nextLines;
    }

    nextLines[targetIndex] = {
        ...targetLine,
        quantity: targetLine.quantity - quantityToRemove,
    };

    return nextLines;
}

function applyUpdateItem(lines: CartLine[], action: CartActionInput, menu: StoreMenuRecord): CartLine[] {
    const targetIndex = findTargetLineIndex(lines, action, menu);
    const nextLines = lines.map(cloneCartLine);
    const targetLine = nextLines[targetIndex];
    const quantityToUpdate = action.quantity ?? targetLine.quantity;

    if (quantityToUpdate > targetLine.quantity) {
        throw new Error(`Cannot update ${quantityToUpdate} item(s) from line ${targetLine.lineId}`);
    }

    const nextItemId = action.itemId ?? targetLine.itemId;
    const mergedSelections = nextItemId === targetLine.itemId
        ? normalizeRequestedSelections(extractStoredOptionSelections(targetLine.selectedOptions), action.selectedOptions)
        : action.selectedOptions;
    const mergedAddOns = nextItemId === targetLine.itemId
        ? (action.selectedAddOns.length > 0 || action.targetSelectedAddOns.length > 0
            ? normalizeRequestedAddOns(action.selectedAddOns)
            : extractStoredAddOnIds(targetLine.selectedOptions))
        : normalizeRequestedAddOns(action.selectedAddOns);

    const updatedItem = enrichRequestedItem(menu, {
        itemId: nextItemId,
        quantity: quantityToUpdate,
        selectedOptions: mergedSelections,
        selectedAddOns: mergedAddOns,
    });

    if (quantityToUpdate === targetLine.quantity) {
        nextLines.splice(targetIndex, 1);
    } else {
        nextLines[targetIndex] = {
            ...targetLine,
            quantity: targetLine.quantity - quantityToUpdate,
        };
    }

    nextLines.push({
        lineId: generateLineId(),
        ...updatedItem,
    });

    return mergeEquivalentLines(nextLines);
}

function buildCartSummary(orderId: string | null, items: CartLine[], pricing: StorePricingRecord): CartSummary {
    const { subtotal, feeTotal, tax, total, taxRate, fees } = calculateOrderPricing(items, pricing);
    const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

    return {
        orderId,
        items,
        itemCount,
        lineCount: items.length,
        subtotal,
        feeTotal,
        tax,
        total,
        taxRate,
        fees,
        currency: DEFAULT_CURRENCY,
    };
}

export function formatCartSummary(summary: CartSummary): string {
    if (summary.items.length === 0) {
        return [
            "Your cart is empty.",
            "- Reply menu to browse items.",
            "- Or send an item name and quantity to start your order.",
        ].join("\n");
    }

    const lines = [
        "Updated cart:",
        `- Order ID: ${summary.orderId}`,
        ...summary.items.map((item) => {
            const options = item.selectedOptions
                .map(formatStoredSelectionLabel)
                .join(", ");

            return options
                ? `- ${item.quantity} x ${item.itemName} (${options})`
                : `- ${item.quantity} x ${item.itemName}`;
        }),
        `- Subtotal: $${summary.subtotal.toFixed(2)}`,
        `- Tax & fees: $${(summary.tax + summary.feeTotal).toFixed(2)}`,
        `- Total: $${summary.total.toFixed(2)}`,
        "- Send another item to keep adding to this order.",
        "- Or reply confirm to submit this order.",
    ];

    return lines.join("\n");
}

export function applyCartActions(input: {
    currentItems: CartLine[];
    actions: CartActionInput[];
    menu: StoreMenuRecord;
    pricing: StorePricingRecord;
    orderId: string;
}): ApplyCartActionsResult {
    let nextLines = input.currentItems.map(cloneCartLine);

    for (const action of input.actions) {
        switch (action.type) {
            case "add_item":
                nextLines = applyAddItem(nextLines, action, input.menu);
                break;
            case "remove_item":
                nextLines = applyRemoveItem(nextLines, action, input.menu);
                break;
            case "update_item":
                nextLines = applyUpdateItem(nextLines, action, input.menu);
                break;
            case "clear_cart":
                nextLines = [];
                break;
            default:
                throw new Error(`Unsupported cart action type: ${action.type satisfies never}`);
        }
    }

    const summary = buildCartSummary(nextLines.length > 0 ? input.orderId : null, nextLines, input.pricing);

    return {
        ...summary,
        summaryText: formatCartSummary(summary),
    };
}
