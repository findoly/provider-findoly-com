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
enquiries
providerleadunlocks
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
- live server-side OTP delivery and verification through the Findoly OTP service;
- no fixed, displayed or accepted development OTP;
- per-mobile OTP resend control plus existing IP, payment and unlock rate limits;
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

CRM approval publishes one enquiry directly to the marketplace. The Provider Portal queries eligible `enquiries` with indexed, cursor-paginated filters. It does not create one row per matching provider.

```text
1 approved lead visible to 1,000 providers = 1 enquiry + 0 unlock rows
8 successful provider unlocks = 8 providerleadunlocks rows
```

### Unlock with credits

A MongoDB transaction:

1. verifies the enquiry is published, unexpired, has capacity, and matches the provider category;
2. atomically claims one remaining unlock slot;
3. expires ended plan allocations and consumes earliest-expiring active credits;
4. creates one idempotent wallet debit when credits are charged;
5. creates one compact `providerleadunlocks` record; and
6. closes marketplace availability when the last slot is taken.

Customer contact stays only on the enquiry. The unlock record stores bounded list/filter snapshots and current provider outcome fields.

### Direct Pay & Unlock

When available credits are insufficient:

1. a local `paymentorders` record and marketplace-slot reservation are committed before calling Razorpay;
2. the unique active reservation key prevents concurrent duplicate checkouts;
3. 18% GST is added to the direct lead checkout;
4. signature, amount, currency and captured status are verified server-side;
5. a successful payment converts the reservation into one unlock record; and
6. no credits are created or added.

Run `npm run cleanup:lead-reservations` every five minutes to release abandoned reservations.

Credit unlock and direct-payment checkout use the same active-reservation key and re-check the opposite method inside the MongoDB transaction, preventing a concurrent request from charging both credits and Razorpay for the same provider and lead.

## Razorpay flow

```text
POST /api/wallet/plan/order
  -> create plan purchase order
  -> save paymentorders record
  -> return Checkout data

POST /api/lead/:leadId/direct-order
  -> create direct lead-unlock order with 18% GST

Razorpay Checkout handler
  -> POST /api/wallet/verify for a plan
  -> POST /api/lead/:leadId/direct-verify for a lead
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

# Run from cron every five minutes
npm run cleanup:lead-reservations
```

Required in production:

```env
NODE_ENV=production
MONGODB_URI=mongodb+srv://.../service_crm_admin
JWT_SECRET=<long-random-secret>
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
TRUST_PROXY=1
```

The provider defaults to the same Findoly OTP namespace as the CRM:

```text
https://api.findoly.com/otp/send-otp
https://api.findoly.com/otp/verify-otp
```

Optional provider OTP overrides:

```env
PROVIDER_OTP_BASE_URL=https://api.findoly.com/otp
PROVIDER_OTP_SEND_URL=
PROVIDER_OTP_VERIFY_URL=
PROVIDER_OTP_API_TOKEN=
PROVIDER_OTP_REQUEST_TIMEOUT_MS=12000
PROVIDER_OTP_RESEND_SECONDS=30
PROVIDER_OTP_MAX_SENDS_PER_WINDOW=2
PROVIDER_OTP_RATE_WINDOW_SECONDS=60
PROVIDER_OTP_SEND_ALLOW_UNCONFIRMED=true
```

`OTP_API_URL`, `OTP_SEND_PATH`, `OTP_VERIFY_PATH`, `OTP_API_TOKEN` and `OTP_TIMEOUT_MS` remain supported as legacy deployment variables. All configured OTP URLs must use HTTPS in production. If the OTP service is unavailable, login fails safely; no general local or fixed OTP fallback exists.

### Temporary Razorpay review login

Razorpay reviewers can use the approved review account only when this explicit deployment flag is enabled:

```env
RAZORPAY_REVIEW_LOGIN_ENABLED=true
```

With the flag enabled, mobile `8693097982` can sign in using OTP `7777`. The account must still exist, be active and have provider-portal access enabled. OTP send-rate limits continue to apply, the review OTP is not returned by the API or displayed in the browser, and every other mobile continues to use the live Findoly OTP service.

Disable the exception immediately after Razorpay completes its review:

```env
RAZORPAY_REVIEW_LOGIN_ENABLED=false
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


## Public policies and support

The following routes are publicly accessible and linked from provider login, the Plans and Credits page and the desktop footer:

```text
/terms-and-conditions
/privacy-policy
/cancellation-and-refund-policy
/shipping-and-service-delivery-policy
/acceptable-use-and-lead-data-policy
/marketplace-disclaimer
/cookie-and-storage-notice
/intellectual-property-and-complaints-policy
/grievance-redressal-policy
/contact-us
/help-support
```

The expanded legal set covers Provider eligibility, OTP and account security, marketplace role, lead quality, digital-credit use and expiry, direct payments, non-refundable activated purchases, customer-data restrictions, cookies and browser storage, intellectual property, complaints and grievance handling. The legal entity is Findoly Solutions LLP. Provider support and grievances are email-only at `support@findoly.com`.

Digital credits and subscriptions activate after verified payment, no physical delivery applies, and successfully purchased and activated credits or subscriptions are non-refundable. Marking a lead invalid does not automatically restore credits. The published text is an operational legal draft and should be reviewed by qualified Indian counsel before production publication, especially the named Grievance Officer designation and any business-specific liability or dispute terms.

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

The provider backend sends these events:

```text
POST /api/communication/events/provider_lead_unlocked
POST /api/communication/events/provider_feedback_updated
```

A successful credit or direct-payment unlock sends an internal Slack event and an email confirmation to the provider email stored in CRM. A successful provider outcome/status update does the same. The provider portal never supplies the destination email address.

A CRM communication failure does not discard an unlock or provider update. The API response includes a pending/failed communication warning, and the CRM Communication Center retains per-channel delivery status for review and retry.

## Seven-day outcome reminder

An unlocked lead with no Confirmed/Not Confirmed outcome becomes overdue after `PROVIDER_OUTCOME_REMINDER_DAYS` (default 7). The dashboard displays a pending count and a dismissible reminder popup. Dismissal lasts only for the current browser session, and the reminder returns in a later session until the outcome is updated.

The reminder warns that Findoly may verify the status with the customer and provider. Incorrect or misleading outcomes are reviewed manually in CRM and may result in a warning, temporary suspension, or permanent restriction.

## Provider appearance

The provider portal is locked to the lightweight **Professional Blue** appearance. Providers do not see an appearance selector, and previously saved browser theme preferences are ignored and removed.


## Rich Lead Card Refinement

The provider lead list now uses compact, coloured insight tiles to reduce empty space and improve scanning. Marketplace cards show preferred timing, lead age, provider interest, and current result. Unlocked cards show customer, preferred timing, outcome, activity, and unlock/action timing. Lead titles are sentence-cased only when displayed; stored records are not modified.
