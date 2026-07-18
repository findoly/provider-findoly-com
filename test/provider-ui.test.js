const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("lead lists use the cache-busted professional feed UI", () => {
  const head = source("views/partials/head.ejs");
  const view = source("views/lead/index.ejs");
  const css = source("public/css/app.css");

  assert.match(head, /app\.css\?v=provider-social-ui-/);
  assert.match(view, /provider-filter-grid/);
  assert.match(view, /provider-feed-card/);
  assert.match(view, /provider-transparency-row/);
  assert.match(view, /provider-feed-aside/);
  assert.doesNotMatch(view, /portal-opportunity-card/);

  for (const selector of [
    ".provider-filter-grid",
    ".provider-feed-layout",
    ".provider-feed-card",
    ".provider-transparency-row",
    ".provider-intent-badge",
  ]) {
    assert.match(css, new RegExp(selector.replace(".", "\\.")));
  }
});

test("provider UI retains synchronized marketplace and outcome features", () => {
  const listView = source("views/lead/index.ejs");
  const detailView = source("views/lead/show.ejs");
  const dashboard = source("views/dashboard/index.ejs");
  const profile = source("views/profile/index.ejs");

  assert.match(listView, /lead\.leadIntent/);
  assert.match(listView, /lead\.unlockedCount/);
  assert.match(listView, /lead\.currentlyConfirmed/);
  assert.match(listView, /lead\.providerDistanceKm/);
  assert.match(detailView, /providerSaleOutcome/);
  assert.match(detailView, /Confirmed/);
  assert.match(detailView, /Not Confirmed/);
  assert.match(detailView, /Activity status/);
  assert.match(dashboard, /pendingOutcomeCount/);
  assert.match(dashboard, /Remind me later/);
  assert.match(profile, /servicePincode/);
});
