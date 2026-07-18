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

## Nearby marketplace and transparency

The CRM is the source of truth for provider categories, the provider's single service PIN code, provider coordinates and Lead Intent. Providers can view the registered service area in the portal, but cannot edit it themselves.

Before an unlock, the provider can see:

- CRM-assigned Lead Intent (`high`, `medium`, `low`, or `not_assessed`);
- approximate distance from the CRM-managed provider service location;
- the number of providers who have unlocked the lead;
- whether any provider currently reports a confirmed sale;
- requirement, location and preferred timing;
- the original credit cost configured by CRM.

There is no dynamic discount. Wallet-credit and direct-payment unlocks always use the CRM-configured lead price. Customer contact information remains hidden until a successful unlock.

Marketplace visibility expands progressively from the lead location:

| Time after marketplace publication | Radius |
|---:|---:|
| 0–5 minutes | 5 km |
| 5–15 minutes | 10 km |
| 15–30 minutes | 25 km |
| 30–60 minutes | 50 km |
| 1–2 hours | 100 km |
| 2–4 hours | 200 km |
| 4–8 hours | 400 km |
| After 8 hours | No platform radius restriction |

Category matching and active-account checks continue to apply at every stage. A successfully unlocked lead is removed from that provider's Marketplace and appears in Unlocked Leads.

## Provider interface

The provider portal uses the Findoly logo and a LinkedIn-inspired responsive workspace with:

- desktop top navigation and provider summary rail;
- feed-style Marketplace and Unlocked Lead cards;
- compact filters;
- a mobile bottom navigation bar;
- mobile-safe lead actions, reminders, profile, wallet and payment screens.

## Provider outcomes and CRM synchronization

Every unlocked lead requires a sale outcome:

- `confirmed`
- `not_confirmed`

The separate activity status is optional and supports `contacted`, `valid`, `follow_up`, `on_hold`, `rejected`, `invalid`, `not_interested`, and `other`.

The provider browser submits to its own backend. The backend stores the update and then calls the CRM Communication Center integration endpoint. Configure both applications with the same token:

```env
# Provider portal
CRM_API_BASE_URL=https://admin.findoly.com
CRM_COMMUNICATION_EVENT_PATH=/api/communication/events
COMMUNICATION_EVENT_API_TOKEN=<shared-random-secret>

# CRM admin
COMMUNICATION_EVENT_API_TOKEN=<same-shared-random-secret>
```

The provider call is sent to:

```text
POST /api/communication/events/provider_feedback_updated
```

A CRM synchronization failure does not discard the provider update. The lead shows the pending synchronization state, and saving the outcome again retries the integration.

## Seven-day outcome reminder

An unlocked lead with no Confirmed/Not Confirmed outcome becomes overdue after `PROVIDER_OUTCOME_REMINDER_DAYS` (default 7). The dashboard displays a pending count and a dismissible reminder popup. Dismissal lasts only for the current browser session, and the reminder returns in a later session until the outcome is updated.

The reminder warns that Findoly may verify the status with the customer and provider. Incorrect or misleading outcomes are reviewed manually in CRM and may result in a warning, temporary suspension, or permanent restriction.

## Full-page appearance themes

The provider account menu includes three lightweight appearance choices. A theme applies to the complete portal, including the header, sidebar, dashboard, Marketplace, My Leads, lead detail, Credits, Profile, filters, forms, tables, mobile navigation and typography. Theme preference is stored in the browser and does not change business data or provider permissions.

The sidebar no longer shows the redundant “Marketplace ready” status block. Provider location remains visible in the account summary and is still managed by CRM.
