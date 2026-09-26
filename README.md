# OmniOrderAI

OmniOrderAI is a multi-tenant food ordering platform built around a TypeScript Azure Functions backend, a WhatsApp ordering flow, and a web operations UI for restaurant owners and tablet devices.

## Current scope

- **Backend**: Azure Functions app in `backend/`
- **Operations web app**: React + Vite app in `web/`
- **Channel in Phase 1**: WhatsApp
- **Payments**: Stripe
- **Customer updates**: payment confirmations and ready-for-pickup notifications now run through a shared notification outbox and are delivered on the original messaging channel
- **State**:
  - PostgreSQL for orders, payments, devices, and status history
  - Azure Table Storage for catalog, conversation state, and cart state

## Repository structure

```text
.
├── backend/        # Azure Functions backend
├── web/            # Owner portal + tablet dashboard
├── architecture.md # Architecture notes
└── README.md
```

## Prerequisites

Install these before running the project locally:

- Node.js 20+
- npm
- Azure Functions Core Tools v4
- Azurite
- PostgreSQL

Optional but useful:

- Stripe CLI for webhook forwarding

## Local setup

### 1. Install dependencies

```bash
cd backend && npm install
cd ../web && npm install
```

### 2. Configure backend settings

Create or update `backend/local.settings.json` with local values for:

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "WHATSAPP_VERIFY_TOKEN": "your_verify_token",
    "WHATSAPP_PHONE_NUMBER_ID": "your_phone_number_id",
    "WHATSAPP_ACCESS_TOKEN": "your_whatsapp_access_token",
    "WHATSAPP_APP_SECRET": "your_whatsapp_app_secret",
    "OPENAI_API_KEY": "your_openai_api_key",
    "OPENAI_MODEL": "gpt-5-nano",
    "STRIPE_SECRET_KEY": "your_stripe_secret_key",
    "STRIPE_WEBHOOK_SECRET": "your_stripe_webhook_secret",
    "STOREFRONT_BASE_URL": "http://localhost:5173",
    "AZURE_STORAGE_CONNECTION_STRING": "UseDevelopmentStorage=true",
    "POSTGRES_CONNECTION_STRING": "your_postgres_connection_string",
    "POSTGRES_SSL": "false",
    "DEFAULT_STORE_OWNER_ACCESS_KEY": "your_local_restaurant_access_key"
  }
}
```

For local WhatsApp testing only, you can optionally add:

```json
"SKIP_WEBHOOK_SIGNATURE_VERIFICATION": "true"
```

**Do not commit real secrets.**

### 3. Initialize PostgreSQL

Apply the schema in `backend/schema.sql` to your local PostgreSQL database.

Example:

```bash
psql "$POSTGRES_CONNECTION_STRING" -f backend/schema.sql
```

### 4. Start the backend

From `backend/`:

```bash
npm run dev
```

This starts:

- Azurite
- TypeScript watch
- Azure Functions host

The API will be available by default at:

```text
http://localhost:7071/api
```

### 5. Run bootstrap initialization

Before using the API, owner portal, or WhatsApp flow, initialize Azure Table Storage, create the required queues, and seed the default catalog:

```bash
curl -X POST http://localhost:7071/api/admin/bootstrap
```

The bootstrap API is idempotent, so it is safe to call again after changing local settings such as `DEFAULT_STORE_OWNER_ACCESS_KEY`, `WHATSAPP_PHONE_NUMBER_ID`, or `WHATSAPP_ACCESS_TOKEN`.

### 6. Start the web app

From `web/` in a separate terminal:

```bash
npm run dev
```

The Vite app will usually be available at:

```text
http://localhost:5173
```

For local development, the web app proxies `/api/*` requests to the Azure Functions app so you should not hit browser CORS issues when both apps run locally.

Two ways to run without a full local backend setup:

- Point the client at a remote Function App for API calls (build-time): set VITE_API_BASE_URL to the remote Functions URL when building.

  cd web
  VITE_API_BASE_URL="https://<FUNCTION_APP>.azurewebsites.net/api" npm run build

- Or skip running the backend locally while using the dev server proxy: set DEV_FUNCTION_HOST before starting dev to forward /api requests to a remote Function App without running the Functions host locally.

  DEV_FUNCTION_HOST="https://<FUNCTION_APP>.azurewebsites.net" npm run dev

Note: VITE_API_BASE_URL is baked into the production bundle at build time. DEV_FUNCTION_HOST is only used for the local Vite dev server proxy to forward requests during development.

If you change the backend port often, you can also update the proxy target in `web/vite.config.ts` (or set DEV_FUNCTION_HOST).
## Local workflows

### Owner portal

The owner portal currently uses:

- restaurant ID
- restaurant access key

For local development, the default store access key is seeded during the bootstrap step from:

```text
DEFAULT_STORE_OWNER_ACCESS_KEY
```

Use the web app at:

```text
/owner
```

Current Phase 1 owner actions:

- list devices
- create device activation codes
- revoke devices

### Device activation + dashboard

Use the web app at:

```text
/device
```

Device flow:

1. Create a device activation code in the owner portal
2. Open `/device/activate` on the tablet
3. Enter the activation code
4. The app stores the returned device token locally
5. The tablet loads `/device/dashboard`

### Stripe webhook testing

If using Stripe locally, forward webhooks to:

```text
http://localhost:7071/api/payment/webhook
```

Example with Stripe CLI:

```bash
stripe listen --forward-to localhost:7071/api/payment/webhook
```

## WhatsApp token

Use a **System User access token** for backend-to-WhatsApp API calls. Meta guide:
<https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens#generating-system-user-access-tokens>

1. Open **Meta Business Settings** -> **System Users**
2. Create a system user
3. Assign the app with **Manage app**
4. Grant WhatsApp account access
5. Generate a token with:
   - `business_management`
   - `whatsapp_business_management`
   - `whatsapp_business_messaging`
6. Store it only in local settings or deployment configuration

## Build and checks

### Backend

```bash
cd backend
npm run build
npm test
```

### Web

```bash
cd web
npm run build
npm run lint
```

## Contributing

### Development principles

- Keep Azure Function handlers thin
- Put business logic in services/shared modules
- Preserve strict TypeScript types
- Keep cart and order mutations deterministic
- Do not hardcode secrets
- Do not let the LLM directly own backend mutations

### Suggested contribution workflow

1. Create a branch for the change
2. Make focused, surgical changes
3. Update docs when behavior or setup changes
4. Run the relevant build/lint/test commands
5. Open a PR with:
   - what changed
   - why it changed
   - how it was verified

### Contribution areas

Good next areas for contribution:

- customer web ordering
- menu management UI
- richer owner authentication
- operational reporting
- additional channels

## Deployment

Web (Azure Static Web Apps)

- Configure the API host at build time. Edit web/.env.production (we added a placeholder) or set the env var when building:

  cd web
  VITE_API_BASE_URL="https://api.example.com" npm run build

- Deploy the built static output (Vite default: `dist`) using your existing SWA CLI configuration. If the Static Web Apps CLI was already set up for this repo, a simple `swa deploy` from the project (or web) folder will pick up that configuration and deploy the `dist` output.

- Best practice: do not commit secrets to source. Because import.meta.env values are baked into the bundle at build time, update VITE_API_BASE_URL and rebuild to change the API host.

Backend (Azure Functions)

- Build and publish the Functions app:

  cd backend
  npm run build
  func azure functionapp publish omniorderai

- Configure production application settings in the Function App (Azure Portal) for secrets and connection strings: POSTGRES_CONNECTION_STRING, AZURE_STORAGE_CONNECTION_STRING, WHATSAPP_*, STRIPE_*, OPENAI_API_KEY, etc. Updating settings in the Portal takes effect without rebuilding the backend.

## Notes

- `architecture.md` captures broader platform architecture and phased direction
- Phase 1 is optimized for **WhatsApp ordering + owner device management + tablet dashboard**
