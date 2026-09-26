# OmniOrder AI – Fast Ordering Architecture (<3s)
Implementation Guide for GitHub Copilot

This document is the **source of truth** for replacing the current ~15s flow with a **fast, safe, atomic** architecture targeting sub-3-second responses.

## Current state (as of this revision)

The following already exists and must be **preserved**:

| Component | File | Status |
|---|---|---|
| WhatsApp webhook → queue → worker | `functions/whatsAppWebHook.ts`, `workers/processIncomingMessage.ts` | ✅ Keep as-is |
| Single structured JSON plan output | `plannerEnvelopeSchema` / `plannerResponseSchema` in `orderingAgent.ts` | ✅ Keep schema |
| Server-side cart mutation | `applyCartActions()` in `services/cartService.ts` | ✅ Keep + extend |
| Cart action types | `cartActionTypeSchema` enum: `add_item`, `update_item`, `remove_item`, `clear_cart` | ✅ Reuse |
| Conversation stages | `ConversationStage` type: `"shopping" \| "awaiting_order_confirmation" \| "submitted"` | ✅ Reuse |
| Table Storage persistence | `shared/stateStore.ts` | ✅ Keep as-is |
| Pricing math | `shared/pricing.ts` — `calculateOrderPricing()`, `PricingSummary` | ✅ Extend |
| Session prompt cache | `shared/sessionContextCache.ts` | ⚠️ Simplify (see below) |
| Deterministic short-circuits | Inside `orderingAgent.ts` (confirm/status/browse/greeting) | ✅ Keep as-is |
| Channel abstraction | `channels/`, `ChannelFactory.ts` | ✅ Keep as-is |

We will **add**:
- `src/gateway/messageGateway.ts` — Fast Gateway Layer: normalize message + choose model
- `src/llm/nanoClient.ts` + `miniClient.ts` — typed wrappers over the existing OpenAI client
- `src/llm/prompts/systemPrompt.ts` — extract `PLANNER_INSTRUCTIONS` from `orderingAgent.ts` here
- `src/retrieval/vectorSearch.ts` — `search_menu` tool backed by PostgreSQL + pgvector
- `src/cart/cartMutationExecutor.ts` — thin coordinator extracted from `orderingAgent.ts`
- Expand `shared/pricing.ts` with a `PriceBreakdown` line-level interface
- `tags?: string[]` field on `MenuItemRecord` in `shared/defaultCatalog.ts`
- `menu_item_embeddings` PostgreSQL table (see §7a)

We will **remove**:
- **Preheat LLM call** — `orderingAgent.ts` currently makes a dummy LLM call on first conversation creation to warm up the connection and pre-cache the large static menu blob (`:344-379`, `:1429-1439`). The new compact context (~500–700 tokens) makes the first real call fast. Delete it.
- **`sessionContextCache.ts` heavy caching** — was solving the "large static prompt per session" problem. With the Runner managing history via `conversationId` and a tiny inline `stateSnapshot`, there is nothing expensive to cache. The file can be deleted or reduced to a no-op.
- **Gateway pronoun resolution** — the gateway previously resolved "it"/"that" from `recentTurns`. The LLM already has full thread history via `conversationId` and can resolve these itself. The gateway only needs to trim/normalize text and classify complexity.

We will **not** replace or restructure:
- The Azure Functions project layout (`src/functions/`, `src/workers/`, `src/services/`, `src/shared/`)
- The queue-based async processing pattern
- The Zod validation layer in `cartService.ts` and `orderingAgent.ts`
- The `CartLine`, `CartSummary`, `ApplyCartActionsResult` types in `cartService.ts`

---

## 1. High-level flow

```txt
WhatsApp Message
  ↓
workers/processIncomingMessage.ts
  ↓ (already exists — keep as-is)
services/orderingAgent.ts  ← runWorkflow()
  ↓
┌─────────────────────────────────────────────────────┐
│  DETERMINISTIC SHORT-CIRCUIT LAYER                  │
│  (keep existing logic in orderingAgent.ts)          │
│  • Direct confirm/submit phrases                    │
│  • Cart/status/menu-browse/greeting commands        │
│  → Returns reply immediately if matched             │
└─────────────────────────────────────────────────────┘
  ↓ (not short-circuited)
┌─────────────────────────────────────────────────────┐
│  FAST GATEWAY LAYER  (gateway/messageGateway.ts)    │
│                                                     │
│  Step 1 — Normalize message:                        │
│    • Trim, collapse whitespace                      │
│    • Detect language (future: translate if needed)  │
│    (pronoun resolution handled by LLM via thread)   │
│                                                     │
│  Step 2 — Choose model (both configurable):         │
│    FAST_MODEL  = env OPENAI_MODEL  (default: gpt-5-nano)   │
│    SMART_MODEL = env OPENAI_SMART_MODEL (default: gpt-4o-mini) │
│    → "fast" | "smart" via complexity heuristics     │
│                                                     │
│  Returns: { normalizedMessage, modelTier }          │
│  ONE model chosen. No fallback. No retry.           │
└─────────────────────────────────────────────────────┘
  ↓ { normalizedMessage, modelTier }
┌─────────────────────────────────────────────────────┐
│  AI AGENT ORCHESTRATOR  (orderingAgent.ts)          │
│                                                     │
│  Conversation threading: Runner + conversationId    │
│    System prompt + menu context sent ONCE on turn 1.│
│    Stored in thread. Subsequent turns use threadId. │
│                                                     │
│  Turn 1 — new conversation (~500–700 tokens):       │
│    • System prompt          < 200 tokens            │
│    • Menu structure (IDs)   ~ 200–400 tokens        │
│    • State snapshot         ~  50–100 tokens        │
│    • User message                                   │
│    → Runner creates thread, returns conversationId  │
│    → Save conversationId to stateStore              │
│                                                     │
│  Turn 2+ — continuing (~100–150 tokens):            │
│    • State snapshot         ~  50–100 tokens        │
│    • User message                                   │
│    • conversationId  (Runner replays thread)        │
│    → System prompt + menu already in thread         │
│                                                     │
│  Calls chosen model ONCE with:                      │
│    - context above (first or continuing)            │
│    - 2 read-only tools (LLM-initiated):             │
│        search_menu(query)  — discovery + full detail │
│        get_cart()          — lineIds for update/remove only │
│                                                     │
│  LLM decides:                                       │
│    • Whether to call tools                          │
│    • Outputs ONE structured PlannerResponse         │
└─────────────────────────────────────────────────────┘
  ↓ structured plan
LLM outputs ONE PlannerResponse (existing plannerResponseSchema):
  type: "cart_mutation" | "ask_clarification" | "respond" | "submit_order" | "show_status" | "show_store_info"
  if cart_mutation → actions: CartActionInput[]
  ↓
cart/cartMutationExecutor.ts  ← NEW: thin coordinator
  - delegates validation + mutation to cartService.applyCartActions() (already exists)
  - delegates pricing to shared/pricing.ts calculateOrderPricing() (already exists)
  - returns PriceBreakdown (new interface in shared/pricing.ts)
  ↓
orderingAgent.ts executePlan()  ← formats and returns OutboundReply
  ↓
WhatsApp reply
```

---

## 2. Updated project structure

Only **new files** are marked `← ADD`. Everything else already exists.

```
/backend/src
  /gateway
    messageGateway.ts        ← ADD (normalize + route; replaces modelRouter.ts)
  /llm
    nanoClient.ts            ← ADD
    miniClient.ts            ← ADD
    plannerSchema.ts         ← ADD (extract plannerEnvelopeSchema + plannerResponseSchema from orderingAgent.ts)
    /prompts
      systemPrompt.ts        ← ADD (extract PLANNER_INSTRUCTIONS from orderingAgent.ts)
  /retrieval
    vectorSearch.ts          ← ADD (search_menu tool — returns full item detail)
    cartTools.ts             ← ADD (get_cart tool)
  /cart
    cartMutationExecutor.ts  ← ADD (thin coordinator)
  /services
    orderingAgent.ts         ← MODIFY: wire gateway, LLM clients, systemPrompt, tools, executor
    cartService.ts           ← KEEP (CartActionInput, applyCartActions — already correct)
  /shared
    pricing.ts               ← MODIFY: add PriceBreakdown interface + recalcTotalsWithBreakdown()
  /config
    environment.ts           ← MODIFY: add OPENAI_SMART_MODEL env var
    constants.ts             ← KEEP (reuse as-is)
  /channels, /functions, /workers, /types, /interfaces
                             ← KEEP all unchanged
```

---

## 3. Fast Gateway Layer
**File**: `src/gateway/messageGateway.ts` ← **NEW**

Sits between the deterministic short-circuits and the LLM call. Purely synchronous — zero network calls. Normalizes the raw message and picks the model. One model per turn, always.

```typescript
export type ModelTier = "fast" | "smart";

export interface GatewayResult {
  normalizedMessage: string;
  modelTier: ModelTier;
}

// Both model names come from environment config — never hardcoded.
// FAST_MODEL  → env OPENAI_MODEL        (default: gpt-5-nano)
// SMART_MODEL → env OPENAI_SMART_MODEL  (default: gpt-4o-mini)

// No recentTurns needed — the LLM resolves pronouns ("it"/"that") from
// its own thread history via conversationId.
export function processMessage(rawMessage: string): GatewayResult {
  const normalized = rawMessage.trim().replace(/\s+/g, " ");
  const modelTier = classifyComplexity(normalized);
  return { normalizedMessage: normalized, modelTier };
}

function classifyComplexity(message: string): ModelTier {
  const lower = message.toLowerCase();

  // Long messages → smart
  if (lower.length > 180) return "smart";

  // Multiple constraint keywords → smart
  const constraints = ["but", "except", "not too", "avoid", "mix of"];
  if (constraints.filter(k => lower.includes(k)).length >= 2) return "smart";

  // Ambiguous references → smart
  if (lower.includes("not that") || lower.includes("the other")) return "smart";

  // Group order complexity → smart
  if (lower.includes("for") && lower.includes("people") && lower.includes("different")) return "smart";

  // Comparison questions → smart
  if (lower.includes("difference between") || lower.includes("compare")) return "smart";

  return "fast";
}
```

**Rules**:
- `processMessage()` is the only entry point. No `recentTurns` parameter — the LLM resolves context from its thread.
- No LLM calls, no async, no side effects.
- Both `OPENAI_MODEL` (fast) and `OPENAI_SMART_MODEL` (smart) are configurable at runtime.

---

## 4. LLM clients (fast + smart)
**Files**: `src/llm/nanoClient.ts`, `src/llm/miniClient.ts` ← **NEW**

Both clients share the same interface. They wrap the existing OpenAI structured-output call in `orderingAgent.ts` (the `Runner.run` pattern). "nano" and "mini" are kept as file names for code continuity — the actual models are env-configured.

```typescript
// Turn 1 — new conversation. System prompt + menu context seed the thread.
export interface NewConversationInput {
  systemPrompt: string;   // < 200 tokens — seeds the thread once
  menuContext: string;    // ~ 200–400 tokens — seeds the thread once (compact IDs only)
  stateSnapshot: string;  // ~ 50–100 tokens — stage + cart hint: "Stage: shopping. Cart: empty."
  userMessage: string;
  // No conversationId — Runner creates the thread and returns one
}

// Turn 2+ — continuing conversation. System prompt + menu already in thread.
export interface ContinuingTurnInput {
  conversationId: string; // existing activeConversationId from stateStore
  stateSnapshot: string;  // ~ 50–100 tokens — always fresh per turn
  userMessage: string;
  // Total per-request: ~100–150 tokens. Everything else is in the thread.
}

export type LlmTurnInput = NewConversationInput | ContinuingTurnInput;

export interface LlmTurnOutput {
  plan: PlannerResponse;     // z.infer<typeof plannerResponseSchema>
  conversationId: string;    // returned by Runner — save to stateStore on turn 1
}

// nanoClient.ts — uses getEnvironmentConfig().openai.model (fast model)
export async function callNano(input: LlmTurnInput, tools: Tool[]): Promise<LlmTurnOutput>;

// miniClient.ts — uses getEnvironmentConfig().openai.smartModel
export async function callMini(input: LlmTurnInput, tools: Tool[]): Promise<LlmTurnOutput>;
```

**Implementation notes**:
- Both clients check `"conversationId" in input` to determine new vs continuing.
- On **turn 1**: pass `systemPrompt` + `menuContext` + `stateSnapshot` + `userMessage` to Runner → get back `conversationId` → save to `stateStore` via existing `saveConversationId()`.
- On **turn 2+**: pass only `conversationId` + `stateSnapshot` + `userMessage` → Runner reuses thread.
- `stateSnapshot` is always included because it changes every turn (stage and cart change). It is injected as a system-level context prefix, not as history.
- `nanoClient` reads `env.openai.model`; `miniClient` reads `env.openai.smartModel`.

---

## 5. System prompt
**File**: `src/llm/prompts/systemPrompt.ts` ← **NEW** (extract from `orderingAgent.ts`)

Move the `PLANNER_INSTRUCTIONS` constant out of `orderingAgent.ts` into this file. No content changes — the existing prompt is correct. Export as:

```typescript
export const PLANNER_SYSTEM_PROMPT: string = `...`; // exact existing PLANNER_INSTRUCTIONS content
```

Update `orderingAgent.ts` to import `PLANNER_SYSTEM_PROMPT` from here instead.

---

## 6. Menu structure for LLM context

**No new files needed.** The menu is already loaded from `shared/catalogStore.ts` and `shared/defaultCatalog.ts`.

The change is in **how we pass it to the LLM**:
- Currently: the full menu JSON is embedded in the static session instructions (`:724-804` of `orderingAgent.ts`).
- New: build a **compact ID-only string** — category names + item IDs + item names only, no prices, no option detail. This reduces prompt token count.

```typescript
// In shared/catalogStore.ts — add alongside existing catalog helpers
export function buildCompactMenuContext(menu: StoreMenuRecord): string {
  // Returns: "Category > item_id: Item Name, item_id: Item Name\n..."
  // No prices, no addOns, no modifiers — LLM uses IDs only, backend validates
}
```

Modifiers and add-on details are injected only for retrieved items (from `vectorSearch`), not the full menu.

---

## 7. LLM Tools (2 total — all read-only)

The LLM has exactly **2 tools**, both read-only. No mutation tools — cart changes happen only via the structured plan output executed by the backend.

**Rule**: The LLM calls tools only when it needs information it doesn't already have. For direct orders ("add 2 chicken bowls"), it skips all tools and returns a `cart_mutation` plan immediately.

---

### Tool 1: `search_menu`
**File**: `src/retrieval/vectorSearch.ts` ← **NEW**

For discovery and detail — when the user asks about ingredients, dietary needs, item types, or options. Returns **full item detail** (description, options, add-ons) so the LLM never needs a second tool call to get modifier IDs.

#### §7a. PostgreSQL schema — `menu_item_embeddings`

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS menu_item_embeddings (
  store_id      INTEGER      NOT NULL,
  item_id       TEXT         NOT NULL,
  item_name     TEXT         NOT NULL,
  category_id   TEXT         NOT NULL,
  category_name TEXT         NOT NULL,
  tags          TEXT[]       NOT NULL DEFAULT '{}',
  description   TEXT,
  options_json  JSONB        NOT NULL DEFAULT '[]',  -- Array<{ optionId, name, choices: [{choiceId, name}] }>
  addons_json   JSONB        NOT NULL DEFAULT '[]',  -- Array<{ addOnId, name }>
  source_text   TEXT         NOT NULL,               -- text that was embedded
  embedding     vector(1536) NOT NULL,               -- text-embedding-3-small
  updated_at    TIMESTAMPTZ  DEFAULT NOW(),
  PRIMARY KEY (store_id, item_id)
);

CREATE INDEX IF NOT EXISTS menu_item_embeddings_hnsw
  ON menu_item_embeddings
  USING hnsw (embedding vector_cosine_ops);
```

All item detail (options, add-ons, description, category name, tags) is written at bootstrap. `searchMenu` is a pure PG query — no in-memory catalog lookup needed at query time. `tags` is a PG array to enable future hard-filter queries (e.g. `WHERE tags @> ARRAY['halal']`).

#### §7b. Source text format (what gets embedded per item)

Tags are placed **first** so they dominate the embedding for dietary/preference queries:

```
"Chicken Bowl. Category: Bowls. Tags: halal, spicy.
Grilled chicken with rice and beans. Options: size (small, regular, large),
sauce (mild, spicy, BBQ). Add-ons: extra cheese, avocado."
```

#### §7c. Bootstrap — embedding generation

Embeddings are generated at **app startup** via `bootstrapService.ts`. Only runs if the table is empty for the store (safe to call on every cold start):

```typescript
// In bootstrapService.ts — add alongside existing catalog init
export async function bootstrapMenuEmbeddings(store: StoreWithMenu): Promise<void> {
  const existing = await sql`
    SELECT COUNT(*) FROM menu_item_embeddings WHERE store_id = ${store.id}
  `;
  if (Number(existing[0].count) > 0) return; // already seeded

  const items = store.menu.categories.flatMap(cat =>
    cat.items.map(item => ({ cat, item }))
  );

  for (const { cat, item } of items) {
    const allOptions = getMenuItemOptions(cat, item);
    const allAddOns  = getMenuItemAddOns(cat, item);
    const tags = item.tags ?? [];

    const sourceText = [
      `${item.name}. Category: ${cat.name}.`,
      tags.length ? `Tags: ${tags.join(", ")}.` : "",
      item.description ?? "",
      allOptions.length
        ? `Options: ${allOptions.map(o => `${o.name} (${o.choices.map(c => c.name).join(", ")})`).join(", ")}.`
        : "",
      allAddOns.length
        ? `Add-ons: ${allAddOns.map(a => a.name).join(", ")}.`
        : "",
    ].filter(Boolean).join(" ");

    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: sourceText,
    });
    const embedding = embeddingResponse.data[0].embedding;

    // Store full item detail — no hydration needed at query time
    const optionsJson = allOptions.map(o => ({
      optionId: o.id,
      name: o.name,
      choices: o.choices.map(c => ({ choiceId: c.id, name: c.name })),
    }));
    const addonsJson = allAddOns.map(a => ({ addOnId: a.id, name: a.name }));

    await sql`
      INSERT INTO menu_item_embeddings
        (store_id, item_id, item_name, category_id, category_name,
         tags, description, options_json, addons_json, source_text, embedding)
      VALUES
        (${store.id}, ${item.id}, ${item.name}, ${cat.id}, ${cat.name},
         ${tags}, ${item.description ?? null},
         ${JSON.stringify(optionsJson)}, ${JSON.stringify(addonsJson)},
         ${sourceText}, ${JSON.stringify(embedding)}::vector)
      ON CONFLICT (store_id, item_id) DO UPDATE
        SET item_name     = EXCLUDED.item_name,
            category_name = EXCLUDED.category_name,
            tags          = EXCLUDED.tags,
            description   = EXCLUDED.description,
            options_json  = EXCLUDED.options_json,
            addons_json   = EXCLUDED.addons_json,
            source_text   = EXCLUDED.source_text,
            embedding     = EXCLUDED.embedding,
            updated_at    = NOW()
    `;
  }
}
```

#### §7d. `searchMenu` implementation

Pure PG query — no in-memory catalog access at query time:

```typescript
export interface SearchMenuResult {
  itemId: string;
  name: string;
  categoryName: string;
  tags: string[];
  description?: string;
  options: Array<{
    optionId: string;
    name: string;
    choices: Array<{ choiceId: string; name: string }>;
  }>;
  addOns: Array<{ addOnId: string; name: string }>;
  // No prices — backend owns all pricing
}

export async function searchMenu(
  query: string,
  storeId: number,
  limit: number
): Promise<SearchMenuResult[]> {
  const cap = Math.min(limit, 3);

  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });
  const queryVec = embeddingResponse.data[0].embedding;

  const rows = await sql<{
    item_id: string; item_name: string; category_name: string;
    tags: string[]; description: string | null;
    options_json: unknown; addons_json: unknown;
  }[]>`
    SELECT item_id, item_name, category_name, tags, description, options_json, addons_json
    FROM menu_item_embeddings
    WHERE store_id = ${storeId}
    ORDER BY embedding <=> ${JSON.stringify(queryVec)}::vector
    LIMIT ${cap}
  `;

  return rows.map(row => ({
    itemId: row.item_id,
    name: row.item_name,
    categoryName: row.category_name,
    tags: row.tags,
    description: row.description ?? undefined,
    options: row.options_json as SearchMenuResult["options"],
    addOns: row.addons_json as SearchMenuResult["addOns"],
  }));
}

// Factory — takes storeId only; all item detail comes from PG
export function makeSearchMenuTool(storeId: number) {
  return tool({
    name: "search_menu",
    description: "Find menu items matching a query. Returns full options and add-ons per item. " +
      "Use limit=1 when you're looking up a specific item by name. " +
      "Use limit=2–3 when you want alternatives or are answering a discovery question ('anything spicy?', 'do you have shrimp?'). " +
      "Maximum is 3. Do NOT call for direct add-to-cart requests where the item name is already clear.",
    parameters: z.object({
      query: z.string(),
      limit: z.number().int().min(1).max(3).default(3)
        .describe("How many items to return. Use 1 for specific lookups, 2–3 for alternatives or discovery."),
    }),
    execute: async ({ query, limit }) => {
      const results = await searchMenu(query, storeId, limit);
      if (!results.length) return "No matching items found.";
      return results.map(r => {
        const tagLine = r.tags.length ? `Tags: ${r.tags.join(", ")}\n` : "";
        const opts = r.options.map(o =>
          `  ${o.name}: ${o.choices.map(c => `${c.choiceId}=${c.name}`).join(", ")}`
        ).join("\n");
        const addOns = r.addOns.map(a => `${a.addOnId}=${a.name}`).join(", ");
        return `${r.itemId}: ${r.name} (${r.categoryName})\n${tagLine}${r.description ?? ""}\nOptions:\n${opts}\nAdd-ons: ${addOns || "none"}`;
      }).join("\n\n");
    },
  });
}
```

---

### Tool 2: `get_cart`
**File**: `src/retrieval/cartTools.ts` ← **NEW**

For cart modification — called **only** when the LLM needs `lineId`s to build an `update_item` or `remove_item` action. The session context carries only a minimal hint (`"2 items, $18.50"`), not full line detail. This avoids sending cart line data on every turn where it isn't needed.

```typescript
// Factory — called per request in orderingAgent.ts with request-scoped identifiers
export function makeGetCartTool(channel: string, channelIdentifier: string, customerPhone: string) {
  return tool({
    name: "get_cart",
    description: "Get the current cart lines with lineIds, item names, quantities, and selected options. Call ONLY when you need to update or remove a specific existing line. Do NOT call when adding new items.",
    parameters: z.object({}),
    execute: async () => {
      const cart = await getCart(channel, channelIdentifier, customerPhone);
      if (!cart?.items?.length) return "Cart is empty.";
      return cart.items.map(line =>
        `lineId=${line.lineId} | ${line.itemName} x${line.quantity} | options: ${
          line.selectedOptions.map(o => `${o.optionId}=${o.choiceId}`).join(", ") || "none"
        }`
      ).join("\n");
    },
  });
}
```

---

### Tool summary

| Tool | Trigger | `limit` guidance | Returns |
|---|---|---|---|
| `search_menu(query, limit)` | Discovery or detail: ingredients, options, dietary questions | `1` for specific lookup, `2–3` for alternatives/discovery. Hard max: **3** | Full item detail from PG: IDs, tags, options, add-ons (no prices) |
| `get_cart()` | Modification: LLM needs lineIds to update/remove a line | n/a | Cart lines with lineIds and current selections |

**Never returned by any tool**: prices, totals, taxes, fees, payment info.

---

## 8. Cart types — reuse existing

**No new type files needed.** The existing types in `cartService.ts` are correct:

| Existing type | Role |
|---|---|
| `CartLine` | One line in the stored cart |
| `CartSummary` | Full cart with calculated totals |
| `CartActionInput` | One LLM-proposed operation (add/update/remove/clear) |
| `CartActionsSchema` / `cartActionTypeSchema` | Zod validation — reuse as-is |
| `ApplyCartActionsResult` | Result of applying a mutation batch |
| `ConversationStage` | `"shopping" \| "awaiting_order_confirmation" \| "submitted"` |

The `PlannerResponse` union type (already defined in `orderingAgent.ts`) maps to these — no aliasing needed.

---

## 9. Cart mutation executor
**File**: `src/cart/cartMutationExecutor.ts` ← **NEW** (thin coordinator only)

Extract the cart-mutation execution path from `orderingAgent.ts → executePlan()` into this dedicated file. The actual mutation logic stays in `cartService.applyCartActions()` — do not duplicate it.

```typescript
import { CartActionInput } from "../services/cartService";
import { applyCartActions, ApplyCartActionsResult } from "../services/cartService";
import { recalcTotalsWithBreakdown, PriceBreakdown } from "../shared/pricing";
import { getCart, saveCart } from "../shared/stateStore";
import { StoreWithMenu } from "../shared/defaultCatalog";

export interface CartMutationResult {
  summary: ApplyCartActionsResult;
  breakdown: PriceBreakdown;
}

export async function executeCartMutation(
  channel: string,
  customerPhone: string,
  channelIdentifier: string,
  actions: CartActionInput[],
  store: StoreWithMenu
): Promise<CartMutationResult> {
  // 1. Load current cart from stateStore (already exists)
  const storedCart = await getCart(channel, channelIdentifier, customerPhone);

  // 2. Delegate to existing cartService.applyCartActions() — do NOT reimplement mutation logic
  const summary = await applyCartActions(storedCart?.items ?? [], actions, store.menu, store.pricing);

  // 3. Persist updated cart (already exists in stateStore)
  await saveCart(channel, channelIdentifier, customerPhone, {
    orderId: storedCart?.orderId ?? null,
    items: summary.items,
  });

  // 4. Return full per-line breakdown (new — see §10)
  const breakdown = recalcTotalsWithBreakdown(summary.items, store.pricing);

  return { summary, breakdown };
}
```

Update `orderingAgent.ts → executePlan()`: when `plan.type === "cart_mutation"`, call `executeCartMutation()` instead of calling `applyCartActions()` inline.

---

## 10. Pricing — expand existing `shared/pricing.ts`
**File**: `src/shared/pricing.ts` ← **MODIFY** (add new interface + function, keep existing)

Keep `calculateOrderPricing()` and `PricingSummary` unchanged. Add:

```typescript
export interface PriceBreakdownLine {
  lineId: string;
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: number;        // base item price
  optionsTotal: number;     // sum of selected option/choice price uplifts
  lineTotal: number;        // (unitPrice + optionsTotal) * quantity
}

export interface PriceBreakdown {
  currency: string;
  lines: PriceBreakdownLine[];
  subtotal: number;
  fees: AppliedStoreFee[];  // already defined
  feeTotal: number;
  tax: number;
  grandTotal: number;
}

// New function — delegates math to existing calculateOrderPricing()
export function recalcTotalsWithBreakdown(
  items: CartLine[],
  pricing: StorePricingRecord
): PriceBreakdown {
  const summary = calculateOrderPricing(items, pricing); // reuse existing
  return {
    currency: DEFAULT_CURRENCY, // from src/config/constants.ts
    lines: items.map(line => ({
      lineId: line.lineId,
      itemId: line.itemId,
      name: line.itemName,
      quantity: line.quantity,
      unitPrice: line.price,
      optionsTotal: line.selectedOptions.reduce((s, o) => s + o.choicePrice, 0),
      lineTotal: (line.price + line.selectedOptions.reduce((s, o) => s + o.choicePrice, 0)) * line.quantity,
    })),
    subtotal: summary.subtotal,
    fees: summary.fees,
    feeTotal: summary.feeTotal,
    tax: summary.tax,
    grandTotal: summary.total,
  };
}
```

**LLM never receives or produces prices, totals, or fees.**

---

## 11. Wiring into `orderingAgent.ts`

`orderingAgent.ts` is the integration point. These are the specific changes:

### 11a. Import new modules
```typescript
import { processMessage } from "../gateway/messageGateway";
import { callNano } from "../llm/nanoClient";
import { callMini } from "../llm/miniClient";
import { PLANNER_SYSTEM_PROMPT } from "../llm/prompts/systemPrompt";
import { makeSearchMenuTool } from "../retrieval/vectorSearch";
import { makeGetCartTool } from "../retrieval/cartTools";
import { executeCartMutation } from "../cart/cartMutationExecutor";
import { buildCompactMenuContext } from "../shared/catalogStore";
```

### 11b. Orchestrator: gateway → one model call
Replace the inline LLM call with the gateway + single model call:

```typescript
// Gateway: normalize message + choose model. Zero network calls.
const { normalizedMessage, modelTier } = processMessage(input.text);

// Tools are factory-created per request — inject request-scoped context
const tools = [
  makeSearchMenuTool(store.id),  // storeId only — full item detail comes from PG
  makeGetCartTool(input.channel, input.channelIdentifier, input.customerPhone),
];

// State snapshot — always fresh, built inline
// cartTotal = existing pre-calculated total already available in runWorkflow() scope
const stateSnapshot = `Stage: ${stage}. Cart: ${
  cart?.items?.length ? `${cart.items.length} item(s), ${formatCurrency(cartTotal)}` : "empty"
}.`;

// First turn: seed the thread. Subsequent turns: reuse it.
const llmInput: LlmTurnInput = activeConversationId
  ? {                                                   // Turn 2+ (~100–150 tokens)
      conversationId: activeConversationId,
      stateSnapshot,
      userMessage: normalizedMessage,
    }
  : {                                                   // Turn 1 (~500–700 tokens)
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      menuContext: buildCompactMenuContext(store.menu),
      stateSnapshot,
      userMessage: normalizedMessage,
    };

// ONE model call per turn. Gateway decision is final.
const { plan, conversationId } = modelTier === "fast"
  ? await callNano(llmInput, tools)
  : await callMini(llmInput, tools);

// Persist conversationId on turn 1 (already exists in stateStore)
if (!activeConversationId) {
  await saveConversationId(input.channel, input.channelIdentifier, input.customerPhone, conversationId);
}
```

The `@openai/agents` Runner manages the thread server-side. Turn 2+ sends only ~100–150 tokens.

### 11c. Replace inline cart mutation with executor call
In `executePlan()`, when `plan.type === "cart_mutation"`:

```typescript
// Before (inline in executePlan):
const result = await applyCartActions(currentCart?.items ?? [], plan.actions, menu, pricing);

// After (delegate to executor):
const { summary, breakdown } = await executeCartMutation(
  input.channel, input.customerPhone, input.channelIdentifier, plan.actions, store
);
// Use summary for reply formatting, breakdown available for richer output if needed
```

### 11d. Keep all existing deterministic paths unchanged
The short-circuit paths for `DIRECT_SUBMIT_PHRASES`, menu browse, cart/status, greetings, and store-info are correct and must not be modified.

---

## 12. Environment variables

Add one new variable. All others already exist.

```bash
# Existing (keep)
OPENAI_API_KEY=<key>
OPENAI_MODEL=gpt-5-nano          # fast model (used by nanoClient)

# New
OPENAI_SMART_MODEL=gpt-4o-mini   # smart model (used by miniClient; fallback: gpt-4o-mini)
```

Update `src/config/environment.ts`:
```typescript
openai: {
  apiKey: string;
  model: string;        // existing — fast model
  smartModel: string;   // NEW — smart model
}
```

In the validator:
```typescript
const openaiSmartModel = process.env.OPENAI_SMART_MODEL || "gpt-4o-mini";
// ...
openai: { apiKey: openaiApiKey!, model: openaiModel, smartModel: openaiSmartModel }
```

---

## 13. Planner schema extraction

**File**: `src/llm/plannerSchema.ts` ← **NEW**

Move `plannerEnvelopeSchema` and `plannerResponseSchema` (and `PlannerResponse` type) out of `orderingAgent.ts` into this file. Both LLM clients need to import them; `orderingAgent.ts` re-imports from here.

```typescript
import { z } from "zod";
import { cartActionsSchema } from "../services/cartService"; // reuse existing schema

export const plannerEnvelopeSchema = z.object({ /* existing definition */ }).strict();
export const plannerResponseSchema = z.discriminatedUnion("type", [ /* existing definition */ ]);
export type PlannerResponse = z.infer<typeof plannerResponseSchema>;
```

---

## 14. Implementation checklist for Copilot

Complete these in order. Each step is independently testable.

| # | Task | File(s) | Depends on |
|---|---|---|---|
| 1 | Extract planner schemas | `src/llm/plannerSchema.ts` | — |
| 2 | Extract system prompt | `src/llm/prompts/systemPrompt.ts` | — |
| 3 | Add `smartModel` to environment config | `src/config/environment.ts` | — |
| 4 | Add `tags?: string[]` to `MenuItemRecord` | `src/shared/defaultCatalog.ts` | — |
| 5 | Create `menu_item_embeddings` PG table + hnsw index | DB migration / `bootstrapService.ts` | — |
| 6 | Add `bootstrapMenuEmbeddings()` | `src/shared/bootstrapService.ts` | 4, 5 |
| 7 | Implement Fast Gateway Layer (no pronoun resolution) | `src/gateway/messageGateway.ts` | — |
| 8 | Implement fast + smart LLM clients | `src/llm/nanoClient.ts`, `miniClient.ts` | 1, 2, 3 |
| 9 | Add `PriceBreakdown` to pricing | `src/shared/pricing.ts` | — |
| 10 | Implement `cartMutationExecutor` | `src/cart/cartMutationExecutor.ts` | 9 |
| 11 | Implement `search_menu` tool (pgvector) | `src/retrieval/vectorSearch.ts` | 5 |
| 12 | Implement `get_cart` tool | `src/retrieval/cartTools.ts` | — |
| 13 | Add `buildCompactMenuContext` | `src/shared/catalogStore.ts` | — |
| 14 | Wire everything into `orderingAgent.ts` | `src/services/orderingAgent.ts` | 7, 8, 10, 11, 12, 13 |
| 15 | **Remove preheat call** from `orderingAgent.ts` | `src/services/orderingAgent.ts` | 14 |
| 16 | **Delete or hollow out `sessionContextCache.ts`** | `src/shared/sessionContextCache.ts` | 14 |
| 17 | Build + verify `npm run build` | — | 15, 16 |
