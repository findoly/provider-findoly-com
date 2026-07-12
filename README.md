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

The frontend controller sends only page metadata such as title and subtitle. Provider, lead, plan, credit and payment records are never rendered into EJS by Express.

Each page owns its body markup. Only these structural partials are shared:

```text
head.ejs
navbar.ejs
sidebar.ejs
footer.ejs
scripts.ejs
```

## Shared CRM collections

The portal reads and writes the same core collections used by the CRM:

```text
providers
leaddistributions
enquiries
wallettransactions
paymentorders
```

The plan system also uses:

```text
creditallocations
providersubscriptions
```

`walletBalancePaise` and the existing `wallettransactions` collection are retained for CRM/database compatibility. In the provider UI they are treated only as credits: 100 stored minor units equal 1 credit. Arbitrary wallet top-ups are disabled.

## Authentication

The browser stores only a signed HTTP-only provider session cookie. The provider object is not cached in application memory.

For every protected page and every protected `/api` request, the portal:

1. verifies the signed cookie;
2. reads the provider again from MongoDB;
3. checks `status = active`;
4. checks `portalAccessEnabled != false`;
5. uses the current categories, profile and credit balance from the database.

Production protections include:

- HTTP-only signed authentication cookie;
- CSRF verification for plan purchases, payment verification, unlocks and status writes;
- OTP, payment and unlock rate limits;
- Helmet security headers and Content Security Policy;
- request IDs in API errors;
- graceful shutdown and MongoDB connection pooling;
- no in-memory identity cache;
- no arbitrary credit or wallet top-up endpoint.

## Plans and credits

The portal provides three plans with manual purchase/renewal:

| Plan | Monthly | Monthly credits | Yearly (GST included) | Yearly credits |
|---|---:|---:|---:|---:|
| Starter | ₹999 + 18% GST | 1,000 | ₹11,999 | 14,400 |
| Growth | ₹2,999 + 18% GST | 3,000 | ₹35,999 | 46,800 |
| Scale | ₹9,999 + 18% GST | 11,000 | ₹89,999 | 126,000 |

Credit calculation follows the approved rule: a listed rupee price ending in `99` rounds up by one for base credits, then the plan bonus is applied.

- Monthly plans last 30 days.
- Yearly plans last 365 days.
- Credits are allocated immediately after verified captured payment.
- Yearly credits are allocated in full immediately.
- Unused plan credits carry forward while the combined subscription remains active.
- Early renewal adds credits immediately and extends validity after the existing expiry.
- Expired credits are deducted and retained in history as `expiry` transactions.
- Existing legacy credit balances are preserved as non-expiring legacy allocations.
- Plans do not auto-renew.

## Lead unlock flow

The CRM creates one `leaddistributions` record for each matching provider. The portal only queries records belonging to the logged-in provider, and locked responses remove customer contact data.

### Unlock with credits

A MongoDB transaction:

1. verifies the offer is available and still matches the provider category;
2. expires any plan credits whose validity ended;
3. consumes the earliest-expiring active credit allocations;
4. updates the provider credit balance;
5. creates the immutable credit debit transaction;
6. unlocks only that provider's distribution;
7. increments the enquiry unlock count.

### Direct Pay & Unlock

When available credits are insufficient, the provider can pay for that specific lead:

1. the lead price is read from the existing pricing data;
2. 18% GST is added at checkout;
3. Razorpay order, signature, amount, currency and captured status are verified server-side;
4. the lead is unlocked once after verification;
5. the payment is recorded in payment history;
6. no credits are created or added.

## Razorpay flow

```text
POST /api/wallet/plan/order
  -> create plan purchase order
  -> save paymentorders record
  -> return Checkout data

POST /api/lead/:leadDistributionId/direct-order
  -> create direct lead-unlock order with 18% GST

Razorpay Checkout handler
  -> POST /api/wallet/verify for a plan
  -> POST /api/lead/:leadDistributionId/direct-verify for a lead
  -> verify server-side HMAC signature
  -> fetch and validate payment from Razorpay
  -> fulfil only after captured status

POST /api/webhooks/razorpay
  -> verify raw-body webhook signature
  -> process payment.captured or order.paid
  -> reuse the same idempotent fulfilment path
```

Checkout confirmation and webhook delivery cannot fulfil the same order twice.

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

Both CRM and provider services must use the same `MONGODB_URI` and database name. MongoDB Atlas or another replica set is required because credit allocation, plan fulfilment and lead unlock use transactions.

Create the new indexes without deleting existing data:

```bash
npm run ensure:indexes
```

## Useful commands

```bash
npm run check
npm test
npm run diagnose:provider -- 8693097982
npm run ensure:indexes
npm audit --omit=dev
```
