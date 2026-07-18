const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("lead lists use the cache-busted minimal UI with advanced filters", () => {
  const head = source("views/partials/head.ejs");
  const view = source("views/lead/index.ejs");
  const css = source("public/css/app.css");

  assert.match(head, /app\.css\?v=provider-operations-ux-/);
  assert.match(view, /provider-minimal-filter/);
  assert.match(view, /provider-advanced-panel/);
  assert.match(view, /provider-advanced-grid/);
  assert.match(view, /provider-minimal-card/);
  assert.match(view, /Advanced filters/);
  assert.match(view, /Lead intent/);
  assert.match(view, /Provider confirmation/);
  assert.match(view, /Sale outcome/);
  assert.doesNotMatch(view, /provider-feed-aside/);
  assert.doesNotMatch(view, /provider-transparency-row/);

  assert.match(css, /Findoly Calm Workspace/);
  assert.match(css, /workspace-sidebar\.portal-sidebar[\s\S]*background: #ffffff/);
  assert.match(css, /workspace-welcome-card[\s\S]*background: #ffffff/);

  for (const selector of [
    ".provider-minimal-filter",
    ".provider-advanced-panel",
    ".provider-advanced-grid",
    ".provider-minimal-card",
    ".provider-dashboard-summary",
    ".provider-recent-row",
  ]) {
    assert.match(css, new RegExp(selector.replace(".", "\\.")));
  }
});

test("provider dashboard is minimal and keeps the required summaries", () => {
  const dashboard = source("views/dashboard/index.ejs");

  assert.match(dashboard, /provider-dashboard-summary/);
  assert.match(dashboard, /Available leads/);
  assert.match(dashboard, /My leads/);
  assert.match(dashboard, /Available credits/);
  assert.match(dashboard, /Priority queue/);
  assert.match(dashboard, /Follow up/);
  assert.match(dashboard, /Confirmed/);
  assert.match(dashboard, /Pending outcomes/);
  assert.match(dashboard, /provider-recent-list/);
  assert.doesNotMatch(dashboard, /How unlocking works/);
  assert.doesNotMatch(dashboard, /portal-dashboard-feed/);
});



test("plans page shows a visible available credits summary and avoids a duplicate page header", () => {
  const plans = source("views/wallet/index.ejs");
  const css = source("public/css/app.css");

  assert.match(plans, /Available credits/);
  assert.match(plans, /provider-credit-overview/);
  assert.match(plans, /provider-credit-overview-value/);
  assert.match(plans, /Use credits/);
  assert.doesNotMatch(plans, /page-header portal-page-header/);
  assert.match(css, /\.provider-credit-overview-value/);
  assert.match(css, /Focused Findoly marketplace UI/);
});

test("lead cards expose useful context before opening without changing unlock behavior", () => {
  const view = source("views/lead/index.ejs");
  const css = source("public/css/app.css");

  assert.match(view, /provider-card-summary/);
  assert.match(view, /provider-card-facts/);
  assert.match(view, /Approx\. distance/);
  assert.match(view, /Preferred timing/);
  assert.match(view, /Lead age/);
  assert.match(view, /View opportunity/);
  assert.match(view, /provider-quick-filters/);
  assert.match(view, /applyQuickFilter/);
  assert.match(view, /WhatsApp/);
  assert.match(view, /phoneHref/);
  assert.match(css, /\.provider-card-facts/);
  assert.match(css, /\.provider-opportunity-card/);
});

test("advanced filters are supported by the provider lead service", () => {
  const service = source("services/lead/lead-service.js");

  for (const filter of [
    "leadIntent",
    "confirmation",
    "unlockCount",
    "pincode",
    "outcome",
    "activityStatus",
    "overdue",
    "minCredits",
    "maxCredits",
    "startDate",
    "endDate",
    "sort",
  ]) {
    assert.match(service, new RegExp(filter));
  }
  assert.match(service, /enquiryIdsForFilters/);
  assert.match(service, /providerConfirmedCount/);
  assert.match(service, /PROVIDER_OUTCOME_REMINDER_DAYS/);
});

test("provider shell uses a minimal seller-panel layout and mobile navigation", () => {
  const navbar = source("views/partials/navbar.ejs");
  const sidebar = source("views/partials/sidebar.ejs");
  const login = source("views/auth/login.ejs");
  const css = source("public/css/app.css");

  assert.match(navbar, /\/images\/findoly-logo\.png/);
  assert.match(login, /\/images\/findoly-logo\.png/);
  assert.match(navbar, /portal-navbar-minimal/);
  assert.match(navbar, /portal-header-credit/);
  assert.match(navbar, /portal-mobile-nav/);
  assert.doesNotMatch(navbar, /portal-global-search/);
  assert.doesNotMatch(navbar, /portal-desktop-nav/);
  assert.match(sidebar, /portal-sidebar-minimal/);
  assert.match(sidebar, /Pending outcomes/);
  assert.doesNotMatch(sidebar, /Marketplace ready/);
  assert.doesNotMatch(sidebar, /Your location and categories are active/);
  assert.doesNotMatch(sidebar, /workspace-sidebar-status/);
  assert.doesNotMatch(sidebar, /portal-provider-card/);
  assert.doesNotMatch(sidebar, /portal-sidebar-help/);
  assert.match(css, /\.portal-navbar-minimal/);
  assert.match(css, /\.portal-sidebar-minimal/);
  assert.match(css, /\.portal-mobile-nav/);
});

test("provider UI retains synchronized marketplace and outcome features", () => {
  const listView = source("views/lead/index.ejs");
  const detailView = source("views/lead/show.ejs");
  const dashboard = source("views/dashboard/index.ejs");
  const profile = source("views/profile/index.ejs");
  const leadService = source("services/lead/lead-service.js");

  assert.match(listView, /lead\.leadIntent/);
  assert.match(listView, /lead\.unlockedCount/);
  assert.match(listView, /lead\.currentlyConfirmed/);
  assert.match(leadService, /marketplaceVisibleAt/);
  assert.match(leadService, /providerDistanceKm/);
  assert.match(detailView, /providerSaleOutcome/);
  assert.match(detailView, /Confirmed/);
  assert.match(detailView, /Not Confirmed/);
  assert.match(detailView, /Activity status/);
  assert.match(dashboard, /pendingOutcomeCount/);
  assert.match(dashboard, /Remind me later/);
  assert.match(profile, /servicePincode/);
});

test("provider location is read-only and CRM managed", () => {
  const profile = source("views/profile/index.ejs");
  const controller = source("controllers/profileController.js");
  const leadList = source("views/lead/index.ejs");

  assert.match(profile, /managed by the Findoly CRM team/i);
  assert.doesNotMatch(profile, /saveLocation\(/);
  assert.doesNotMatch(profile, /api\/profile\/location/);
  assert.match(controller, /CRM_MANAGED_LOCATION/);
  assert.match(leadList, /pending in CRM/i);
});


test("provider shell offers three lightweight full-portal themes", () => {
  const head = source("views/partials/head.ejs");
  const navbar = source("views/partials/navbar.ejs");
  const scripts = source("views/partials/scripts.ejs");
  const css = source("public/css/app.css");

  for (const theme of ["Professional Blue", "Pure Monochrome", "Marketplace Green"]) {
    assert.match(navbar, new RegExp(theme));
    assert.match(scripts, new RegExp(theme));
  }

  for (const id of ["professional-blue", "pure-monochrome", "marketplace-green"]) {
    assert.match(head, new RegExp(id));
    assert.match(css, new RegExp(`data-portal-theme=\"${id}\"`));
  }

  assert.doesNotMatch(navbar, /Network Blue|Social Sky|Calm Chat|Creative Mint|Talent Green|Trade Orange|Local Coral|Care Teal|Clear Neutral|Warm Sand/);
  assert.match(css, /Three lightweight full-portal themes/);
  assert.match(css, /--theme-font-body/);
  assert.match(css, /--theme-font-heading/);
  assert.match(css, /--theme-header-bg/);
  assert.match(css, /--theme-sidebar-bg/);
  assert.match(css, /workspace-topbar\.portal-navbar,[\s\S]*background: var\(--theme-header-bg\)/);
  assert.match(css, /workspace-sidebar\.portal-sidebar,[\s\S]*background: var\(--theme-sidebar-bg\)/);
  assert.match(css, /portal-card,[\s\S]*background: var\(--theme-card-bg\)/);
});

test("mobile provider navigation has native click controls and safe drawer layering", () => {
  const navbar = source("views/partials/navbar.ejs");
  const sidebar = source("views/partials/sidebar.ejs");
  const scripts = source("views/partials/scripts.ejs");
  const css = source("public/css/app.css");

  assert.match(navbar, /data-portal-menu-toggle/);
  assert.match(sidebar, /id="providerSidebar"/);
  assert.match(sidebar, /data-portal-menu-close/);
  assert.match(scripts, /initializeProviderNavigation/);
  assert.match(scripts, /setProviderSidebarOpen/);
  assert.match(css, /body\.portal-sidebar-open \.workspace-sidebar\.portal-sidebar/);
  assert.match(css, /pointer-events: auto/);
});

test("lead marketplace keeps cards below the sticky header and shows a compact dashboard summary", () => {
  const view = source("views/lead/index.ejs");
  const css = source("public/css/app.css");

  assert.match(view, /workspace-market-dashboard/);
  assert.match(view, /OPPORTUNITY MARKETPLACE/);
  assert.match(view, /AVAILABLE CREDITS/);
  assert.match(view, /ACTIVE FILTERS/);
  assert.match(css, /workspace-lead-command[\s\S]*z-index: 1020/);
  assert.match(css, /workspace-topbar\.portal-navbar[\s\S]*z-index: 1100/);
  assert.match(css, /scroll-padding-top/);
  assert.match(css, /text-transform: uppercase/);
});


test("provider dashboard exposes task counts and lead detail has productivity actions", () => {
  const dashboardService = source("services/dashboard/dashboard-service.js");
  const dashboard = source("views/dashboard/index.ejs");
  const detail = source("views/lead/show.ejs");
  const css = source("public/css/app.css");

  assert.match(dashboardService, /followUp/);
  assert.match(dashboardService, /confirmed/);
  assert.match(dashboard, /provider-dashboard-command/);
  assert.match(dashboard, /provider-priority-queue/);
  assert.match(detail, /provider-detail-breadcrumb/);
  assert.match(detail, /provider-detail-quick-actions/);
  assert.match(css, /Findoly Provider Operations UX/);
});
