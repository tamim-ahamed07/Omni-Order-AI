-- OmniOrder AI — PostgreSQL transactional schema
-- Static store/menu catalog lives in Azure Table Storage:
--   channelIdentifier -> storeId mapping
--   storeId -> store/menu JSON document
-- This schema is for transactional data only.

-- Compatible with PostgreSQL 15+.

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
    id                  VARCHAR(100)    PRIMARY KEY, -- Agent-generated orderId
    store_id            INT             NOT NULL,    -- External catalog storeId
    store_name          VARCHAR(255)    NOT NULL,    -- Snapshot for reporting/history
    fulfillment_type    VARCHAR(20)     NOT NULL DEFAULT 'pickup',
    channel             VARCHAR(50)     NOT NULL,    -- 'whatsapp', 'sms', 'web'
    channel_identifier  VARCHAR(100)    NOT NULL,    -- e.g. WhatsApp phoneNumberId / botId / shortcode
    customer_phone      VARCHAR(50)     NOT NULL,
    customer_name       VARCHAR(255),
    subtotal            DECIMAL(10, 2)  NOT NULL,
    fee_total           DECIMAL(10, 2)  NOT NULL DEFAULT 0,
    tax                 DECIMAL(10, 2)  NOT NULL,
    total               DECIMAL(10, 2)  NOT NULL,
    currency            VARCHAR(10)     NOT NULL DEFAULT 'USD',
    status              VARCHAR(50)     NOT NULL DEFAULT 'new',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_orders_fulfillment_type CHECK (
        fulfillment_type IN ('pickup', 'delivery')
    ),
    CONSTRAINT chk_orders_status CHECK (
        status IN ('new', 'queued_for_open', 'accepted', 'in_progress', 'ready', 'completed', 'cancelled')
    )
);

CREATE INDEX idx_orders_store_id         ON orders(store_id);
CREATE INDEX idx_orders_customer_phone   ON orders(customer_phone);
CREATE INDEX idx_orders_status           ON orders(status);
CREATE INDEX idx_orders_channel_lookup   ON orders(channel, channel_identifier);
CREATE INDEX idx_orders_created_at       ON orders(created_at);

-- ---------------------------------------------------------------------------
-- Order line items
-- ---------------------------------------------------------------------------
CREATE TABLE order_items (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id        VARCHAR(100)    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id    VARCHAR(100)    NOT NULL, -- Snapshot of source menu item id
    item_name       VARCHAR(255)    NOT NULL, -- Snapshot of display name
    quantity        INT             NOT NULL,
    unit_price      DECIMAL(10, 2)  NOT NULL,
    line_subtotal   DECIMAL(10, 2)  NOT NULL,
    sort_order      INT             NOT NULL DEFAULT 0,
    CONSTRAINT chk_order_items_quantity CHECK (quantity > 0)
);

CREATE INDEX idx_order_items_order_id ON order_items(order_id, sort_order, id);

-- ---------------------------------------------------------------------------
-- Selected options for each order line item
-- ---------------------------------------------------------------------------
CREATE TABLE order_item_selections (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_item_id   INT             NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    option_id       VARCHAR(100)    NOT NULL,
    option_name     VARCHAR(255),
    choice_id       VARCHAR(100)    NOT NULL,
    choice_name     VARCHAR(255),
    choice_price    DECIMAL(10, 2)  NOT NULL DEFAULT 0,
    sort_order      INT             NOT NULL DEFAULT 0
);

CREATE INDEX idx_order_item_selections_order_item
    ON order_item_selections(order_item_id, sort_order, id);

-- ---------------------------------------------------------------------------
-- Order status change history
-- ---------------------------------------------------------------------------
CREATE TABLE order_status_history (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id    VARCHAR(100)    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status      VARCHAR(50)     NOT NULL,
    note        VARCHAR(1000),
    changed_at  TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_order_status_history_status CHECK (
        status IN ('new', 'queued_for_open', 'accepted', 'in_progress', 'ready', 'completed', 'cancelled')
    )
);

CREATE INDEX idx_order_status_history_order_id
    ON order_status_history(order_id, changed_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Generic notification outbox
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
    id                      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type                    VARCHAR(100)    NOT NULL,
    audience                VARCHAR(50)     NOT NULL,
    channel                 VARCHAR(50)     NOT NULL,
    channel_identifier      VARCHAR(100)    NOT NULL,
    recipient               VARCHAR(100)    NOT NULL,
    entity_type             VARCHAR(50)     NOT NULL,
    entity_id               VARCHAR(100)    NOT NULL,
    dedupe_key              VARCHAR(255)    NOT NULL UNIQUE,
    payload                 JSONB           NOT NULL,
    delivery_status         VARCHAR(20)     NOT NULL DEFAULT 'pending',
    processing_started_at   TIMESTAMPTZ,
    sent_at                 TIMESTAMPTZ,
    skipped_at              TIMESTAMPTZ,
    last_error              VARCHAR(1000),
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_notifications_audience CHECK (
        audience IN ('customer', 'store', 'owner')
    ),
    CONSTRAINT chk_notifications_delivery_status CHECK (
        delivery_status IN ('pending', 'processing', 'sent', 'skipped')
    )
);

CREATE INDEX idx_notifications_delivery_status
    ON notifications(delivery_status, created_at, id);

CREATE INDEX idx_notifications_entity
    ON notifications(entity_type, entity_id, created_at DESC, id DESC);

CREATE INDEX idx_notifications_recipient
    ON notifications(channel, channel_identifier, recipient, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Payments (Stripe webhook events)
-- ---------------------------------------------------------------------------
-- Every order should have a corresponding payments row initialized as `unpaid`.
CREATE TABLE payments (
    id                      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id                VARCHAR(100)    NOT NULL UNIQUE REFERENCES orders(id),
    stripe_checkout_session_id VARCHAR(255),
    stripe_payment_intent_id VARCHAR(255),
    checkout_url            VARCHAR(1000),
    amount                  DECIMAL(10, 2)  NOT NULL,
    currency                VARCHAR(10)     NOT NULL DEFAULT 'USD',
    status                  VARCHAR(50)     NOT NULL DEFAULT 'unpaid',
    expires_at              TIMESTAMPTZ,
    paid_at                 TIMESTAMPTZ,
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_payments_status CHECK (
        status IN ('unpaid', 'paid', 'cancelled', 'expired')
    )
);

CREATE INDEX idx_payments_order_id        ON payments(order_id);
CREATE INDEX idx_payments_status          ON payments(status);
CREATE INDEX idx_payments_checkout_session_id ON payments(stripe_checkout_session_id);
CREATE INDEX idx_payments_payment_intent_id   ON payments(stripe_payment_intent_id);

-- ---------------------------------------------------------------------------
-- Stripe webhook event idempotency
-- ---------------------------------------------------------------------------
CREATE TABLE payment_webhook_events (
    id                      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    stripe_event_id         VARCHAR(255)    NOT NULL UNIQUE,
    order_id                VARCHAR(100)    REFERENCES orders(id) ON DELETE SET NULL,
    event_type              VARCHAR(100)    NOT NULL,
    checkout_session_id     VARCHAR(255),
    payment_intent_id       VARCHAR(255),
    payload                 JSONB           NOT NULL,
    processed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_webhook_events_order_id
    ON payment_webhook_events(order_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Dashboard devices
-- ---------------------------------------------------------------------------
CREATE TABLE devices (
    id                  VARCHAR(100)    PRIMARY KEY,
    store_id            INT             NOT NULL,
    name                VARCHAR(255)    NOT NULL,
    token_hash          VARCHAR(64)     NOT NULL UNIQUE,
    status              VARCHAR(20)     NOT NULL DEFAULT 'active',
    last_seen_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    revoked_at          TIMESTAMPTZ,
    CONSTRAINT chk_devices_status CHECK (
        status IN ('active', 'revoked')
    )
);

CREATE INDEX idx_devices_store_id ON devices(store_id, created_at DESC);
CREATE INDEX idx_devices_status ON devices(status);

-- ---------------------------------------------------------------------------
-- Device activation sessions
-- ---------------------------------------------------------------------------
CREATE TABLE device_activation_sessions (
    id                      VARCHAR(100)    PRIMARY KEY,
    store_id                INT             NOT NULL,
    device_name             VARCHAR(255)    NOT NULL,
    activation_code_hash    VARCHAR(64)     NOT NULL UNIQUE,
    status                  VARCHAR(20)     NOT NULL DEFAULT 'pending',
    expires_at              TIMESTAMPTZ     NOT NULL,
    consumed_at             TIMESTAMPTZ,
    activated_device_id     VARCHAR(100)    REFERENCES devices(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_device_activation_sessions_status CHECK (
        status IN ('pending', 'consumed', 'expired', 'cancelled')
    )
);

CREATE INDEX idx_device_activation_sessions_store_id
    ON device_activation_sessions(store_id, created_at DESC);
CREATE INDEX idx_device_activation_sessions_status
    ON device_activation_sessions(status, expires_at);

-- ---------------------------------------------------------------------------
-- Menu item vector embeddings (pgvector)
-- Used by the search_menu tool for semantic menu search.
-- Populated at bootstrap via bootstrapMenuEmbeddings().
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS menu_item_embeddings (
    store_id        INTEGER         NOT NULL,
    item_id         TEXT            NOT NULL,
    item_name       TEXT            NOT NULL,
    category_id     TEXT            NOT NULL,
    category_name   TEXT            NOT NULL,
    tags            TEXT[]          NOT NULL DEFAULT '{}',
    description     TEXT,
    options_json    JSONB           NOT NULL DEFAULT '[]',   -- Array<{ optionId, name, choices: [{choiceId, name}] }>
    addons_json     JSONB           NOT NULL DEFAULT '[]',   -- Array<{ addOnId, name }>
    source_text     TEXT            NOT NULL,                -- text that was embedded
    embedding       vector(1536)    NOT NULL,                -- text-embedding-3-small
    updated_at      TIMESTAMPTZ     DEFAULT NOW(),
    PRIMARY KEY (store_id, item_id)
);

-- hnsw index for cosine similarity — fast even as catalog grows
CREATE INDEX IF NOT EXISTS menu_item_embeddings_hnsw
    ON menu_item_embeddings
    USING hnsw (embedding vector_cosine_ops);
