# Provider Lead Portal

A separate Express service connected to the same MongoDB database as the Service CRM Admin.

## Architecture

```text
/frontend/* or normal browser URL
  -> frontend controller renders an EJS shell only
  -> Alpine.js in the page calls /api/*
  -> JSON controller
  -> small service
  -> simple Mongoose model
  -> shared MongoDB database
```

The frontend controller sends only page metadata such as title and subtitle. Provider, lead, wallet and transaction records are never rendered into EJS by Express.

Each page owns its body markup. Only these structural partials are shared:

```text
head.ejs
navbar.ejs
sidebar.ejs
footer.ejs
scripts.ejs
```

## Shared CRM collections

The portal reads and writes the same collections used by the CRM:

```text
providers
leaddistributions
enquiries
wallettransactions
paymentorders
```

The shared Mongoose model files match the CRM model fields. The application uses named 32-character UUID fields:

```text
providers             providerId
leaddistributions      leadDistributionId
enquiries              enquiryId
wallettransactions     walletTransactionId
paymentorders          paymentOrderId
```

MongoDB `_id` is left untouched. Compatibility reads still accept an existing legacy `id` where a migration has not yet added the named field.

## Authentication

The browser stores only a signed HTTP-only provider session cookie. The provider object is not cached in application memory.

For every protected page and every protected `/api` request, the portal:

1. verifies the signed cookie;
2. reads the provider again from MongoDB;
3. checks `status = active`;
4. checks `portalAccessEnabled != false`;
5. uses the current categories, profile and wallet balance from the database.

This means CRM changes such as disabling portal access or deactivating the provider apply on the next request without restarting the provider server.

Production protections include:

- HTTP-only signed authentication cookie;
- CSRF token verification for write APIs;
- OTP, wallet and unlock rate limits;
- Helmet security headers and Content Security Policy;
- request IDs in API errors;
- graceful shutdown and MongoDB connection pooling;
- no in-memory identity cache;
- no direct wallet-credit endpoint.

## Lead flow

The CRM creates one `leaddistributions` record for each matching provider. The portal only queries records where `providerId` belongs to the logged-in provider.

Locked responses remove customer contact fields. The portal also removes contact-like keys from `additionalDetails` before unlock.

Unlocking uses a MongoDB transaction to:

1. verify the offer is still available and matches the provider category;
2. verify the provider is still active and portal-enabled;
3. deduct the exact `leadPricePaise`;
4. create the immutable wallet debit transaction;
5. mark only that provider's distribution as unlocked;
6. increment the lead's unlock count.

Use MongoDB Atlas or a replica set because wallet credit and lead unlock require transactions.

## Razorpay wallet flow

```text
POST /api/wallet/order
  -> create Razorpay order
  -> save paymentorders record
  -> return Checkout data

Razorpay Checkout handler
  -> POST /api/wallet/verify
  -> verify server-side HMAC signature
  -> fetch the payment from Razorpay
  -> validate order, amount and INR currency
  -> credit only after captured status

POST /api/webhooks/razorpay
  -> verify signature from the raw request body
  -> process payment.captured or order.paid
  -> reuse the same idempotency key
```

Checkout confirmation and webhook delivery cannot credit the same order twice. An authorised but not-yet-captured payment remains pending until capture/webhook processing.

Configure the webhook URL as:

```text
https://provider.example.com/api/webhooks/razorpay
```

Subscribe to:

```text
payment.captured
order.paid
```

## Production configuration

```bash
cp .env.example .env
npm ci --omit=dev
npm run ensure:indexes
npm start
```

Required in production:

```env
NODE_ENV=production
MONGODB_URI=mongodb+srv://.../service_crm_admin
JWT_SECRET=<long-random-secret>
OTP_API_URL=https://your-otp-service.example.com
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
TRUST_PROXY=1
```

Both CRM and provider services must use the same `MONGODB_URI` and database name.

Before starting the provider portal against an existing CRM database, run the CRM structure migration once:

```bash
cd service-crm-admin
npm install
npm run migrate:structure
```

Then return to this provider project and create any missing indexes without deleting existing data:

```bash
npm run ensure:indexes
```

## Provider eligibility

A provider can sign in and use APIs when:

```text
status = active
portalAccessEnabled = true or missing
providerId or legacy id is present
```

The onboarding stage is displayed but does not independently block login.

To receive new locked leads, the provider must also have matching `categorySlugs` in the CRM.

## Useful commands

```bash
npm run check
npm test
npm run diagnose:provider -- 8693097982
npm run ensure:indexes
npm audit --omit=dev
```

The diagnosis command prints the configured database, provider eligibility, wallet balance, categories and current available/unlocked offer counts.
