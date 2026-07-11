# Provider Lead Portal

A separate Express service connected to the same MongoDB database as the CRM.

## Code flow

```text
Browser page
  -> EJS with Alpine.js
  -> /api route
  -> controller
  -> small service
  -> simple Mongoose model
  -> shared MongoDB
```

No lead, provider, wallet, or profile data is rendered by the server into EJS.

## Main structure

```text
app.js
bin/www
db/connection.js
routes/frontend.js
routes/main.js
routes/lead.js
routes/wallet.js
controllers/frontendController.js
controllers/leadController.js
services/lead/lead-service.js
models/LeadDistribution.js
views/lead/*.ejs
```

All modules use `module.exports`.

## Shared collections

```text
providers
leaddistributions
enquiries
wallettransactions
paymentorders
```

Models explicitly use those collection names and the named IDs `providerId`, `leadDistributionId`, `enquiryId`, `walletTransactionId`, and `paymentOrderId`.

Legacy documents without the named ID are still found through their existing `id` or `_id`. Run the CRM migration to permanently add the named fields.

## Lead unlock

The provider sees a denormalized lead offer. Contact fields are removed from the API response until that provider unlocks its own offer.

Unlock uses:

1. an atomic `offered -> unlocking` claim
2. a conditional wallet debit requiring sufficient balance
3. an immutable wallet transaction
4. an `unlocked` offer update
5. compensation if a later step fails

This flow works with a normal local MongoDB server and does not require a replica set.

## Run

```bash
cp .env.example .env
npm install
npm start
```

Both applications must use the same `MONGODB_URI`.

Development login:

```text
Mobile: a CRM provider mobile
OTP: 123456
```

## API examples

```text
POST /api/auth/send-otp
POST /api/auth/verify-otp
GET  /api/profile
GET  /api/dashboard
GET  /api/lead
GET  /api/lead/:leadDistributionId
POST /api/lead/:leadDistributionId/unlock
GET  /api/wallet
POST /api/wallet/orders
POST /api/wallet/verify
```

## Validation

```bash
npm run check
npm test
npm run diagnose:provider -- 8693097982
```

## Provider UI

The provider portal keeps the Alpine.js + `/api` architecture while using the full provider workspace layout:

- fixed top search bar and wallet balance
- provider summary and vertical icon sidebar
- dashboard statistic cards and recent lead table
- compact lead marketplace filters and table
- lead detail facts, requirement table and wallet unlock panel
- responsive mobile sidebar

EJS templates receive only page metadata and fetch provider data through `/api` with Alpine.js.
