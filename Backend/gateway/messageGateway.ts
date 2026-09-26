/**
 * Fast Gateway Layer — purely synchronous, zero network calls.
 * Normalizes raw inbound text and chooses the model tier.
 * ONE model chosen per turn; decision is final (no fallback, no retry).
 *
 * Models are env-configured:
 *   FAST_MODEL  → env OPENAI_MODEL         (default: gpt-5-nano)
 *   SMART_MODEL → env OPENAI_SMART_MODEL   (default: gpt-4o-mini)
 *
 * Pronoun resolution ("it"/"that") is intentionally omitted here — the LLM
 * resolves these from its own thread history via conversationId.
 */

export type ModelTier = "fast" | "smart";

export interface GatewayResult {
    normalizedMessage: string;
    modelTier: ModelTier;
}

export function processMessage(rawMessage: string): GatewayResult {
    const normalizedMessage = rawMessage.trim().replace(/\s+/g, " ");
    const modelTier = classifyComplexity(normalizedMessage);
    return { normalizedMessage, modelTier };
}

function classifyComplexity(message: string): ModelTier {
    const lower = message.toLowerCase();

    // Long messages signal complex multi-part requests
    if (lower.length > 180) return "smart";

    // Multiple constraint keywords indicate compound conditions
    const constraints = ["but", "except", "not too", "avoid", "mix of"];
    if (constraints.filter((k) => lower.includes(k)).length >= 2) return "smart";

    // Ambiguous negation references
    if (lower.includes("not that") || lower.includes("the other")) return "smart";

    // Group order with per-person customization
    if (lower.includes("for") && lower.includes("people") && lower.includes("different")) return "smart";

    // Comparison or contrast questions
    if (lower.includes("difference between") || lower.includes("compare")) return "smart";

    return "fast";
}
