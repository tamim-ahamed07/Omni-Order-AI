# 📘 **OmniOrder AI Architecture Specification**
### _Backend + Omni-channel Ordering + Multi-Tenant Store System_

This document defines the complete architecture for Softdaemon's ordering platform, including:

- WhatsApp ordering pipeline
- Web ordering UI
- Multi-tenant store routing
- Real-time order updates
- Databases (SQL + NoSQL)
- Queues + Workers
- Deployment targets

---

# 0. **Implementation Phases**

The system is built in phases. Each phase is independently deployable and adds production value.

| Phase | Focus | Status |
|---|---|---|
| **Phase 1** | Channel abstraction, AI agent, Stripe payment link | ✅ Complete |
| **Phase 2** | Queue-based async processing, webhook security | 🔨 Next |
| **Phase 3** | Persistent state (Table Storage + SQL), multi-tenant menus | 📋 Planned |
| **Phase 4** | SSE real-time updates, restaurant dashboard, delivery | 📋 Planned |

---

# 1. **High-Level System Overview**

OmniOrder AI supports multiple channels (WhatsApp, SMS, Telegram, Web Ordering UI), currently starting with:

1. **WhatsApp Ordering**
   - WhatsApp → Webhook → `incoming-messages` Queue → Worker → AI Agent → Order API → SQL

2. **Web Ordering UI**
   - React → `/store/:storeId` → Menu → Cart → Checkout → Order API → SQL

Both channels share the same backend logic and databases.

---

# 2. **Backend Architecture (Azure Functions)**

The backend is a **single Azure Functions App** (TypeScript, v4 programming model) containing:

- **HTTP Functions** (APIs + webhook receivers)
- **Queue-triggered Worker Functions** (AI processing, order lifecycle)
- **SSE Function** for real-time updates _(Phase 4)_
- **Shared modules** (AI agent, channels, SQL, Table Storage, event publisher)

Later, SSE may be split into a separate Function App for independent scaling.

## ⚠️ Critical Design Rules

1. **Webhook handlers must return 200 immediately** — AI calls (5–30 s) must run in a queue worker, not inline. WhatsApp retries on timeout causing duplicate messages.
2. **No module-level mutable state** — Azure Functions may serve concurrent requests in the same process. All per-request state (`cacheKey`, `context`) must be scoped to the function call, not module globals.
3. **Validate all inbound webhooks** — WhatsApp POST: verify `X-Hub-Signature-256`. Stripe POST: verify webhook signature with the Stripe SDK before trusting any payload.
4. **Fail gracefully** — Queue workers must not throw; push failures to dead-letter and log. The customer should always receive a reply.

---

## 2.1 **HTTP Functions**

### `GET|POST /api/whatsapp`
- **GET**: Validate Meta webhook challenge (verify token check)
- **POST**: Validate `X-Hub-Signature-256`, push raw payload to `incoming-messages` queue, return 200 immediately
- **No AI call here** — all processing is async in the worker

### `GET /api/store/:storeId`
- Returns store config + menu from SQL
- Includes theme colors, logo, menu categories, items
- Cached at CDN layer for performance

### `POST /api/order`
- Validates order payload (Zod)
- Creates order + order items in SQL
- Pushes event to `order-events` queue
- Returns `orderId`

### `GET /api/order-status/:orderId`
- Returns current order status from SQL
- Used by web UI as fallback (if SSE unavailable)

### `POST /api/payment/confirm`
- Stripe webhook receiver
- **Verifies Stripe webhook signature** before processing
- Updates payment status in SQL
- Pushes event to `payment-events` queue

### `GET /api/order-updates` (SSE — Phase 4)
- Long-lived SSE connection
- Streams order status events to restaurant dashboard and customer tracking
- Subscribes to event publisher (in-memory local dev → Redis in production)

---

## 2.2 **Worker Functions**

### `processIncomingMessage` (Phase 2)
- **Trigger**: `incoming-messages` queue
- Deserializes message payload
- Loads conversation + cart state from Table Storage
- Calls AI agent (`runWorkflow`)
- Sends WhatsApp reply
- Persists updated conversation + cart state to Table Storage
- If order confirmed → calls `/api/order`
- On error: catches, sends apology reply, logs — does NOT rethrow (prevents poison message loop)

### `processOrderEvents` (Phase 4)
- **Trigger**: `order-events` queue
- Reads `channel`, `customer_from`, `session_key` from the order in SQL
- Sends status update to customer via their **original ordering channel** (WhatsApp, SMS, etc.) — skipped if order was placed via web UI
- Publishes SSE event to `eventPublisher` for web order tracking page — always fires
- Both paths run in parallel (`Promise.all`)
- Calls delivery provider (Uber Direct, etc.) on `order_accepted` event
- Updates SQL order status

### `processPaymentEvents` (Phase 4)
- **Trigger**: `payment-events` queue
- Updates SQL payment status
- Publishes SSE event to subscribers

---

## 2.3 **Shared Modules**

### `channels/` — Messaging Channel Abstraction
- `IMessagingChannel.ts` — interface: `extractMessages`, `sendMessage`, `validateWebhook`, `getSessionKey`
- `WhatsAppChannel.ts` — WhatsApp implementation (extraction, sending, verification)
- `ChannelFactory.ts` — factory + `ChannelType` enum; add SMS/Telegram without touching calling code

### `agent/` — AI Ordering Agent
- `orderingAgent.ts` — Agent definition (instructions, tools, model settings). Pure definition, no mutable state.
- `cartService.ts` — Cart + conversation state management. In Phase 1: in-memory with TTL. Phase 3: delegates to `stateStore.ts`.
- `tools/` — One file per tool (`getMenuTool.ts`, `addToCartTool.ts`, `submitOrderTool.ts`)

### `services/`
- `messageProcessor.ts` — Orchestrates per-sender message extraction → workflow → reply dispatch
- `paymentService.ts` — Stripe payment link creation, webhook signature verification
- `whatsappExtractor.ts` — Webhook payload parsing, message normalization
- `whatsappSender.ts` — WhatsApp Graph API send (single + batch)

### `shared/`
- `aiClient.ts` — AI runner wrapper with retry, timeout, tracing
- `sqlClient.ts` — SQL connection pool, query helpers, order/payment CRUD _(Phase 3)_
- `stateStore.ts` — Azure Table Storage wrapper for conversation + cart state _(Phase 3)_
- `eventPublisher.ts` — In-memory pub/sub (local dev); swap for Redis in production _(Phase 4)_

### `config/`
- `environment.ts` — Singleton env var validator; throws at startup if required vars missing
- `constants.ts` — API versions, TTLs, tax rate, error/success messages, HTTP codes
- `channelConfig.ts` — Per-channel config (auth tokens, phone number IDs)

---

# 3. **Data Architecture**

## 3.1 **Relational Database (PostgreSQL)**
Used for all transactional data.

### Tables:
- `restaurants` — storeId, name, slug, config (JSON), hours, address, taxRate, active
- `menus` — menuId, storeId, version, active
- `menu_items` — itemId, menuId, name, price, categoryId, options (JSON), active
- `orders` — orderId, storeId, customerId, **channel**, **customer_from**, **session_key**, status, subtotal, tax, total, createdAt  _(channel/customer_from/session_key required for post-order notifications back to the customer)_
- `order_items` — orderItemId, orderId, itemId, itemName, quantity, unitPrice, selectedOptions (JSON)
- `payments` — paymentId, orderId, provider, externalId, status, amount, confirmedAt
- `customers` — customerId, channel, externalId (phone/userId), name, createdAt

### Why SQL:
- ACID transactions
- Auditable order history
- Reporting-friendly
- Perfect for orders + payments

---

## 3.2 **NoSQL (Azure Table Storage)**
Used for high-volume, low-cost conversational data.

### Tables:
- `ConversationState` — PartitionKey: `{channel}_{sessionKey}`, RowKey: `{from}`, `history` (JSON), `lastActivity`
- `CartState` — PartitionKey: `{channel}_{sessionKey}`, RowKey: `{from}`, `orderId`, `items` (JSON), `totals`, `lastActivity`

### Why Table Storage:
- Near-zero cost at scale
- No joins needed
- Perfect for chat session state

---

## 3.3 **Queues (Azure Storage Queue)**

### `incoming-messages`
- Payload: `{ from, sessionKey, channel, rawPayload, receivedAt }`
- WhatsApp → AI processing pipeline
- Visibility timeout: 30 s; max dequeue: 3 (then dead-letter)

### `order-events`
- Payload: `{ orderId, storeId, eventType, data, timestamp }`
- Order lifecycle → delivery provider integration

### `payment-events`
- Payload: `{ paymentId, orderId, eventType, stripeEventId, timestamp }`
- Payment lifecycle → order status updates

---

# 4. **Web Ordering UI Architecture**

The web UI is a **mobile-first React app (Vite + React)** hosted on **Azure Static Web Apps**.

## UI Stack

| Tool | Purpose | License |
|---|---|---|
| **Vite** | Build tool + dev server (instant HMR, fast builds) | MIT — Free |
| **React** | UI component library | MIT — Free |
| **Tailwind CSS** | Utility-first styling, mobile-first by default | MIT — Free |
| **shadcn/ui** | Pre-built accessible components (cards, sheets, modals, toasts) built on Tailwind + Radix UI. You own the code — components are copied into your project, not imported from a package. | MIT — Free |

## Per-Tenant Theming

Each restaurant has its own brand colors and logo. Tailwind + shadcn/ui supports this via CSS variables loaded dynamically from the store config API:

```css
/* Applied at runtime from GET /api/store/:storeId response */
:root {
  --primary: 24 95% 53%;   /* restaurant brand color */
  --radius: 0.75rem;
}
```

No separate build per restaurant — one app, infinite tenants.

## 4.1 **Routing**

```
/store/:storeId                    — Menu page
/store/:storeId/cart               — Cart + checkout
/store/:storeId/order/:orderId     — Order tracking (SSE)
/restaurant-dashboard              — Staff real-time view (SSE)
```

## 4.2 **Pages**

### `/store/:storeId`
- Fetches store config + menu from `/api/store/:storeId`
- Mobile-first layout with categories + items
- Cart state in local storage or React context

### `/store/:storeId/cart`
- Checkout form (name, phone, address)
- Submits to `/api/order`
- Redirects to order tracking page

### `/store/:storeId/order/:orderId`
- Shows live order status via SSE (`/api/order-updates?orderId=...`)
- Falls back to polling `/api/order-status/:orderId` if SSE unavailable

### `/restaurant-dashboard`
- Staff view of incoming orders in real time
- SSE subscription for all orders for the store

## 4.3 **Image Strategy**

- **Storage**: Azure Blob Storage — `/storeId/menu/itemId.jpg`, `/storeId/logo.png`
- **Delivery**: Azure CDN with responsive images (`srcset`)

---

# 5. **Real-Time Updates (SSE — Phase 4)**

### `/api/order-updates`
- SSE endpoint (long-lived HTTP connection)
- Query params: `?orderId=...` (customer tracking) or `?storeId=...` (dashboard)
- Event types: `order_created`, `order_accepted`, `order_preparing`, `order_ready`, `order_out_for_delivery`, `order_delivered`, `payment_confirmed`

### Event Publisher
- **Local dev**: In-memory `Map<subscriberId, WritableStream>`
- **Production**: Redis pub/sub (swap `eventPublisher.ts` implementation only)
- SSE Function App can be split out later for independent scaling

---

# 6. **Security**

| Concern | Mitigation |
|---|---|
| WhatsApp webhook spoofing | Verify `X-Hub-Signature-256` (HMAC-SHA256 of body with app secret) |
| Stripe webhook spoofing | Verify `Stripe-Signature` header with `stripe.webhooks.constructEvent()` |
| Function auth | Azure Function key or API Management for non-webhook endpoints |
| Secrets | Azure Key Vault or App Settings (never hardcoded) |
| SQL injection | Parameterized queries; Prisma or `pg` prepared statements |
| Rate limiting | Azure API Management or per-IP queue throttling |

---

# 7. **Deployment Architecture**

## 7.1 **Backend**
- Azure Functions App (Consumption plan, auto-scaling)
- Queue + worker pattern decouples ingestion from processing
- Optional: separate Function App for SSE (Phase 4)

## 7.2 **Web UI**
- Azure Static Web Apps (Free Tier)
- Global CDN, free SSL, GitHub Actions CI/CD

## 7.3 **Images**
- Azure Blob Storage + Azure CDN

---

# 8. **Local Development Setup**

### Tools:
- Azure Functions Core Tools (`func`)
- Azurite (local Queue + Table Storage emulator)
- PostgreSQL local or managed PostgreSQL
- React dev server: `npm run dev` (Vite)

### Flow:
1. `azurite --silent &` — start storage emulator
2. `func start` — start Functions app
3. `npm run dev` — start web UI
4. Test WhatsApp webhook via Postman
5. Watch: queue → worker → Table Storage state → SSE updates

---

# 9. **Project Structure**

```
/SoftCom (Azure Functions App)
  /src
    /channels
      IMessagingChannel.ts       — Channel interface
      WhatsAppChannel.ts         — WhatsApp implementation
      ChannelFactory.ts          — Factory + ChannelType enum
    /agent
      orderingAgent.ts           — Agent definition (stateless)
      cartService.ts             — Conversation + cart state management
      /tools
        getMenuTool.ts
        addToCartTool.ts
        submitOrderTool.ts
    /functions
      whatsAppWebHook.ts         — GET verify + POST → queue push
      paymentWebhook.ts          — Stripe webhook handler
      getStore.ts                — Store config + menu (Phase 3)
      createOrder.ts             — Create order in SQL (Phase 3)
      getOrderStatus.ts          — Order status polling (Phase 3)
      orderUpdatesSSE.ts         — SSE stream (Phase 4)
    /workers
      processIncomingMessage.ts  — Queue: AI + reply (Phase 2)
      processOrderEvents.ts      — Queue: delivery + status (Phase 4)
      processPaymentEvents.ts    — Queue: payment status (Phase 4)
    /services
      messageProcessor.ts        — Extract → workflow → send
      paymentService.ts          — Stripe link + signature verification
      whatsappExtractor.ts       — Webhook payload normalization
      whatsappSender.ts          — WhatsApp Graph API send
    /shared
      sqlClient.ts               — SQL pool + CRUD helpers (Phase 3)
      stateStore.ts              — Table Storage wrapper (Phase 3)
      eventPublisher.ts          — Pub/sub for SSE (Phase 4)
    /config
      environment.ts             — Env var validation singleton
      constants.ts               — Global constants
      channelConfig.ts           — Per-channel config
    /types
      WhatsAppTypes.ts           — Webhook payload types
      OrderTypes.ts              — Order, cart, payment types
    index.ts                     — Function registrations
  host.json
  local.settings.json
  package.json
  tsconfig.json

/web (Vite + React)
  /components
  /pages
    /store/[storeId]/
    /store/[storeId]/cart
    /store/[storeId]/order/[orderId]
    /restaurant-dashboard
  /lib
    apiClient.ts
    sseClient.ts
  package.json
```

---

# 10. **Queue Message Schemas**

```typescript
// incoming-messages queue
interface IncomingMessageQueuePayload {
  from: string;           // sender phone / userId
  sessionKey: string;     // channel account key (phoneNumberId, botId, etc.)
  channel: ChannelType;   // 'whatsapp' | 'sms' | 'telegram'
  rawPayload: unknown;    // original webhook body (already verified)
  receivedAt: string;     // ISO timestamp
}

// order-events queue
interface OrderEventQueuePayload {
  orderId: string;
  storeId: string;
  eventType: 'order_created' | 'order_accepted' | 'order_preparing' | 'order_ready' | 'order_out_for_delivery' | 'order_delivered';
  data: Record<string, unknown>;
  timestamp: string;
}

// payment-events queue
interface PaymentEventQueuePayload {
  paymentId: string;
  orderId: string;
  eventType: 'payment_confirmed' | 'payment_failed' | 'payment_refunded';
  stripeEventId: string;
  timestamp: string;
}
```

---

# 11. **Environment Variables**

```bash
# WhatsApp
WHATSAPP_PHONE_NUMBER_ID=<waba_phone_id>
WHATSAPP_ACCESS_TOKEN=<access_token>
WHATSAPP_VERIFY_TOKEN=<verify_token>
WHATSAPP_APP_SECRET=<app_secret>          # for X-Hub-Signature-256 verification

# OpenAI
OPENAI_API_KEY=<key>
OPENAI_MODEL=gpt-4o-mini

# Stripe
STRIPE_SECRET_KEY=<sk_...>
STRIPE_WEBHOOK_SECRET=<whsec_...>         # for webhook signature verification
STOREFRONT_BASE_URL=https://your-domain.com

# Storage (Phase 2+)
AZURE_STORAGE_CONNECTION_STRING=<conn>    # queues + table storage

# SQL (Phase 3+)
POSTGRES_CONNECTION_STRING=<conn>
POSTGRES_SSL=true

# Redis (Phase 4+, optional)
REDIS_CONNECTION_STRING=<conn>
```

---

# 12. **Copilot Implementation Notes**

- Generate TypeScript Azure Functions (v4 programming model)
- Use Azure SDKs: `@azure/storage-queue`, `@azure/data-tables`
- Use `pg` or Prisma for SQL
- Scaffold Vite + React pages with mobile-first design
- Implement SSE using readable streams (not `EventSource` — that's the client side)
- Use environment variables for all connection strings (never hardcode)
- Keep code modular and multi-tenant from the start
- No module-level mutable state — all state local to function invocation

---

# 13. **Customer Notification Strategy**

When an order status changes, the customer is notified via **two parallel paths**:

```
Order status changes
        ↓
processOrderEvents worker
      ↙                  ↘
channel.sendMessage()    eventPublisher.publish()
(original order channel) (SSE → web tracking page)
WhatsApp / SMS / Telegram  /store/:storeId/order/:orderId
```

Both paths fire in parallel (`Promise.all`). One worker handles both.

## Which path fires

| Customer's channel | Messaging update | Web tracking |
|---|---|---|
| WhatsApp | ✅ sendMessage via WhatsApp | ✅ SSE (if they have the URL) |
| SMS | ✅ sendMessage via SMS | ✅ SSE (if they have the URL) |
| Web UI | ❌ No messaging channel | ✅ SSE always fires |

```typescript
// processOrderEvents worker — notification logic
const order = await sqlClient.getOrder(event.orderId);

await Promise.all([
    // Path 1: notify via original channel (skip if order placed via web)
    order.channel !== 'web'
        ? ChannelFactory
            .getChannel(order.channel)
            .sendMessage(order.customerFrom, formatStatusMessage(event.eventType))
        : Promise.resolve(),

    // Path 2: SSE for web tracking — always fires regardless of channel
    eventPublisher.publish(`order:${order.orderId}`, {
        type: event.eventType,
        orderId: order.orderId,
        timestamp: event.timestamp
    })
]);
```

## What makes this work — channel abstraction

The `ChannelFactory.getChannel(order.channel)` call returns the correct channel implementation transparently. Adding SMS or Telegram support in the future does not require changing the worker — only registering a new channel in `ChannelFactory`.

## Required `orders` table fields

The worker needs to know how to reach the customer back. Three fields must be stored at order creation time:

```sql
channel        VARCHAR(20)   NOT NULL  -- 'whatsapp' | 'sms' | 'telegram' | 'web'
customer_from  VARCHAR(100)  NOT NULL  -- phone number, Telegram userId, etc.
session_key    VARCHAR(100)  NOT NULL  -- channel account context (phoneNumberId, botId, etc.)
```

These values are available at `submitOrder` time from `WorkflowInput` (`from`, `sessionKey`, `channel`) and must be written to SQL when the order is created.

## Status message formatting

Each channel may format the status message differently (WhatsApp supports bold, emoji; SMS is plain text). The `IMessagingChannel` interface should expose an optional `formatStatusUpdate(eventType, order)` method, falling back to a plain-text default.

```typescript
// IMessagingChannel.ts
formatStatusUpdate?(eventType: OrderEventType, order: Order): string;
```
