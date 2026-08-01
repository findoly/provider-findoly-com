"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("provider login links to the public joining page", () => {
  const login = read("views/auth/login.ejs");
  const routes = read("routes/frontend.js");
  assert.match(login, /Join Findoly as a Provider/);
  assert.match(login, /href="\/join-as-provider"/);
  assert.match(routes, /router\.get\("\/join-as-provider", guestOnly, providerRequestController\.page\)/);
});

test("public joining page uses live categories and Google address autocomplete", () => {
  const view = read("views/auth/join-as-provider.ejs");
  const controller = read("controllers/providerRequestController.js");
  const service = read("services/provider-request/provider-request-service.js");
  assert.match(view, /categories\.forEach/);
  assert.match(view, /google\.maps\.places\.Autocomplete/);
  assert.match(view, /componentRestrictions:\s*\{ country: 'in' \}/);
  assert.match(view, /googlePlaceId/);
  assert.match(controller, /GOOGLE_MAPS_API_KEY/);
  assert.match(service, /Category\.find\(\{ active: \{ \$ne: false \} \}\)/);
  assert.match(service, /\$or: \[\{ categoryId \}, \{ id: categoryId \}\]/);
});

test("joining submission is public but protected before provider authentication", () => {
  const main = read("routes/main.js");
  const route = read("routes/provider-request.js");
  const rateLimit = read("middleware/rate-limit.js");
  assert.ok(main.indexOf('router.use("/provider-requests"') < main.indexOf("router.use(apiAuth)"));
  assert.match(route, /providerJoinLimiter/);
  assert.match(route, /verifyCsrf/);
  assert.match(rateLimit, /PROVIDER_JOIN_REQUEST_LIMIT_PER_HOUR/);
});

test("joining requests share a bounded indexed collection with CRM", () => {
  const model = read("models/ProviderJoinRequest.js");
  const service = read("services/provider-request/provider-request-service.js");
  const indexes = read("scripts/ensure-indexes.js");
  assert.match(model, /collection:\s*"providerjoinrequests"/);
  assert.match(model, /status:\s*1, createdAt:\s*-1/);
  assert.match(model, /normalizedMobile:\s*1, status:\s*1/);
  assert.match(model, /partialFilterExpression: \{ \$or:/);
  assert.doesNotMatch(model, /normalizedMobile:\s*\{[^}]*index:\s*true/);
  assert.match(model, /normalizedEmail/);
  assert.match(model, /conversionLockAt/);
  assert.match(service, /withTransaction/);
  assert.match(service, /syncEntityContacts/);
  assert.match(service, /entityType:\s*"provider_join_request"/);
  assert.match(service, /consent/);
  assert.match(service, /website/);
  assert.match(service, /error\?\.code === 11000/);
  assert.match(service, /UNSUPPORTED_TEXT/);
  assert.match(indexes, /ProviderJoinRequest/);
  assert.match(indexes, /ContactIdentity/);
});

test("provider CSP permits only the Google hosts needed by address autocomplete", () => {
  const app = read("app.js");
  assert.match(app, /https:\/\/maps\.googleapis\.com/);
  assert.match(app, /https:\/\/maps\.gstatic\.com/);
  assert.match(app, /https:\/\/places\.googleapis\.com/);
  assert.match(app, /https:\/\/fonts\.gstatic\.com/);
});
