"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("mobile marketplace uses a compact filter launcher and closed sheet consumes no layout space", () => {
  const view = source("views/lead/index.ejs");
  const css = source("public/css/app.css");

  assert.match(view, /provider-mobile-filter-launcher/);
  assert.match(view, /Search &amp; filters/);
  assert.match(view, /provider-mobile-filter-backdrop/);
  assert.match(view, /is-mobile-open/);
  assert.match(view, /provider-mobile-filter-search-control/);
  assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.workspace-filter-card \{[\s\S]*display: none !important/);
  assert.match(css, /\.workspace-filter-card\.is-mobile-open[\s\S]*display: block !important/);
  assert.match(css, /\.provider-mobile-filter-backdrop\.is-open[\s\S]*position: fixed/);
  assert.match(css, /border-radius: 18px 18px 0 0/);
});

test("dashboard available count reuses marketplace visibility and excludes provider unlocks", () => {
  const marketplace = source("services/marketplace/marketplace-service.js");
  const dashboard = source("services/dashboard/dashboard-service.js");

  assert.match(marketplace, /async function countMarketplace/);
  assert.match(marketplace, /buildMarketplaceQuery\(provider/);
  assert.match(marketplace, /ProviderLeadUnlock\.find\(/);
  assert.match(marketplace, /visibilityFor\(provider, lead\)/);
  assert.match(marketplace, /lead\.marketplaceVisibleAt <= now/);
  assert.match(marketplace, /lead\.providerDistanceKm <= maxDistanceKm/);
  assert.doesNotMatch(marketplace, /\.aggregate\s*\(|\$expr/);
  assert.match(dashboard, /marketplaceService\.countMarketplace\(provider/);
  assert.doesNotMatch(dashboard, /boundedCount\(Enquiry, marketplaceQuery/);
});

test("provider joining request enables employee-linked overlap without weakening same-role identity registry", () => {
  const service = source("services/provider-request/provider-request-service.js");
  const identity = source("services/contact-identity/contact-identity-service.js");
  const model = source("models/ContactIdentity.js");

  assert.match(service, /allowEmployeeRoleOverlap:\s*true/);
  assert.match(identity, /EMPLOYEE_LINKED_TYPES/);
  assert.match(identity, /hasEmployeeOwner/);
  assert.match(identity, /if \(check\.entityType === entityType\) return/);
  assert.match(model, /sharedOwners/);
  assert.match(model, /"agent", "provider", "employee", "provider_join_request"/);
});
