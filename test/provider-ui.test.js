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

  assert.match(head, /app\.css\?v=provider-grid-row-neutral-/);
  assert.match(view, /provider-minimal-filter/);
  assert.match(view, /provider-advanced-panel/);
  assert.match(view, /provider-advanced-grid/);
  assert.match(view, /provider-minimal-card/);
  assert.match(view, /Advanced filters/);
  assert.match(view, /Priority/);
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

test("provider dashboard is managed-first and keeps the required operational summaries", () => {
  const dashboard = source("views/dashboard/index.ejs");

  assert.match(dashboard, /provider-dashboard-summary/);
  assert.match(dashboard, /New requirements/);
  assert.match(dashboard, /Assigned requirements/);
  assert.match(dashboard, /Action required/);
  assert.match(dashboard, /Available credits/);
  assert.match(dashboard, /Priority queue/);
  assert.match(dashboard, /Follow-ups/);
  assert.match(dashboard, /Confirmed/);
  assert.match(dashboard, /Not Confirmed/);
  assert.match(dashboard, /Pending outcomes/);
  assert.match(dashboard, /provider-recent-list/);
  assert.doesNotMatch(dashboard, /Explore marketplace|Review marketplace leads|Open marketplace|Available leads/);
  assert.doesNotMatch(dashboard, /How unlocking works/);
  assert.doesNotMatch(dashboard, /portal-dashboard-feed/);
});



test("plans page shows a visible available credits summary and avoids a duplicate page header", () => {
  const plans = source("views/wallet/index.ejs");
  const css = source("public/css/app.css");

  assert.match(plans, /Available credits/);
  assert.match(plans, /provider-credit-overview/);
  assert.match(plans, /provider-credit-overview-value/);
  assert.match(plans, /View assigned requirements/);
  assert.doesNotMatch(plans, /page-header portal-page-header/);
  assert.match(css, /\.provider-credit-overview-value/);
  assert.match(css, /Focused Findoly marketplace UI/);
});

test("lead cards expose useful context before opening without changing unlock behavior", () => {
  const view = source("views/lead/index.ejs");
  const css = source("public/css/app.css");

  assert.match(view, /provider-card-summary/);
  assert.match(view, /provider-lead-insight-grid/);
  assert.match(view, /providers accessed/);
  assert.match(view, /access slots remaining/);
  assert.match(view, /Current result/);
  assert.match(view, /displaySentenceCase\(lead\.leadTitle/);
  assert.match(view, /distanceLabel\(lead\)/);
  assert.match(view, /preferredLabel\(lead\)/);
  assert.match(view, /relativeAge\(lead\.marketplacePublishedAt/);
  assert.match(view, /View &amp; unlock requirement/);
  assert.match(view, /provider-quick-filters/);
  assert.match(view, /applyQuickFilter/);
  assert.match(view, /WhatsApp/);
  assert.match(view, /phoneHref/);
  assert.match(css, /\.provider-decision-card/);
  assert.match(css, /\.provider-opportunity-card/);
});

test("advanced filters are supported by the provider lead services", () => {
  const leadService = source("services/lead/lead-service.js");
  const marketplaceService = source("services/marketplace/marketplace-service.js");
  const service = `${leadService}\n${marketplaceService}`;

  for (const filter of [
    "priority",
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
  assert.match(marketplaceService, /providerConfirmedCount/);
  assert.match(marketplaceService, /remainingUnlocks/);
  assert.match(service, /cursorPaginate/);
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
  assert.doesNotMatch(sidebar, /portal-sidebar-account workspace-sidebar-account/);
  assert.match(sidebar, /workspace-sidebar-mobile-head/);
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
  const marketplaceService = source("services/marketplace/marketplace-service.js");

  assert.match(listView, /lead\.priority/);
  assert.match(listView, /lead\.unlockedCount/);
  assert.match(listView, /lead\.providerConfirmedCount/);
  assert.match(marketplaceService, /marketplaceVisibleAt/);
  assert.match(marketplaceService, /marketplacePublishedAt/);
  assert.match(marketplaceService, /providerDistanceKm/);
  assert.match(leadService, /ProviderLeadUnlock/);
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


test("provider shell is locked to the professional blue appearance", () => {
  const head = source("views/partials/head.ejs");
  const navbar = source("views/partials/navbar.ejs");
  const scripts = source("views/partials/scripts.ejs");
  const css = source("public/css/app.css");

  assert.match(head, /dataset\.portalTheme = 'professional-blue'/);
  assert.match(head, /removeItem\('providerPortalTheme'\)/);
  assert.doesNotMatch(navbar, /Appearance|Pure Monochrome|Marketplace Green|portalThemeChoices/);
  assert.doesNotMatch(scripts, /portalThemes|setTheme\(|themeLabel\(|appearanceOpen/);
  assert.match(css, /data-portal-theme="professional-blue"/);
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
  assert.match(scripts, /providerDrawerState/);
  assert.match(scripts, /data-drawer-open/);
  assert.match(scripts, /window\.location\.assign\(href\)/);
  assert.match(scripts, /document\.documentElement\.style\.overflow/);
  assert.match(css, /body\.portal-sidebar-open \.workspace-sidebar\.portal-sidebar/);
  assert.match(css, /pointer-events: auto/);
  assert.match(css, /z-index: 2100/);
  assert.match(css, /z-index: 2090/);
  assert.match(css, /workspace-sidebar-content[\s\S]*overflow: hidden !important/);
  assert.match(css, /workspace-sidebar-nav[\s\S]*overflow-y: auto !important/);
  assert.match(css, /workspace-sidebar-footer[\s\S]*safe-area-inset-bottom/);
});

test("credit packages explain the Not Confirmed refund review as a visual timeline", () => {
  const plans = source("views/wallet/plans.ejs");
  const css = source("public/css/app.css");
  const head = source("views/partials/head.ejs");

  assert.match(plans, /provider-refund-guide/);
  assert.match(plans, /provider-refund-timeline/);
  assert.match(plans, /How credit refunds work/);
  assert.match(plans, /does not refund credits automatically/);
  assert.match(plans, /Approved: credits are returned to your account credit balance/);
  assert.match(plans, /Not approved: the original credit charge remains/);
  assert.match(plans, /requirements paid with account credits where credits were actually charged/);
  assert.match(plans, /Direct-payment transactions are not described by this credit-refund flow/);
  assert.doesNotMatch(plans, /lead-pack-estimate[\\s\\S]*Not Confirmed starts a Findoly review/);
  assert.match(css, /\.provider-refund-timeline/);
  assert.match(css, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /provider-refund-step:not\(:last-child\)::after/);
  assert.match(head, /mobile-drawer-refund-20261005-1/);
});

test("lead pages keep cards below the fixed header without the oversized workspace summary", () => {
  const view = source("views/lead/index.ejs");
  const css = source("public/css/app.css");

  assert.doesNotMatch(view, /provider-conversion-hero/);
  assert.doesNotMatch(view, /Turn customer leads into business|Find leads worth unlocking/);
  assert.match(view, /workspace-lead-command/);
  assert.match(view, /View &amp; unlock requirement/);
  assert.match(view, /Customer phone number/);
  assert.match(css, /provider-lead-page\.workspace-leads-page[\s\S]*display: block/);
  assert.match(css, /workspace-topbar\.portal-navbar[\s\S]*z-index: 1300/);
  assert.match(css, /provider-unlock-cta/);
  assert.match(css, /scroll-padding-top/);
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


test("provider navigation omits duplicate account summary and customer labels use safe display formatting", () => {
  const sidebar = source("views/partials/sidebar.ejs");
  const scripts = source("views/partials/scripts.ejs");
  const list = source("views/lead/index.ejs");
  const detail = source("views/lead/show.ejs");

  assert.doesNotMatch(sidebar, /provider\.businessName \|\| provider\.name/);
  assert.match(scripts, /function displayTitleCase/);
  assert.match(scripts, /function displaySentenceCase/);
  assert.match(scripts, /function displayLocation/);
  assert.match(list, /displayTitleCase\(lead\.customerName/);
  assert.match(detail, /displayTitleCase\(contact\.name/);
});


test("unlocked lead cards use compact coloured insight tiles and sentence-cased titles", () => {
  const list = source("views/lead/index.ejs");
  const detail = source("views/lead/show.ejs");
  const dashboard = source("views/dashboard/index.ejs");
  const css = source("public/css/app.css");

  assert.match(list, /provider-lead-insight-grid/);
  assert.match(list, /is-customer/);
  assert.match(list, /is-activity/);
  assert.match(list, /Outcome overdue/);
  assert.match(list, /displaySentenceCase\(lead\.leadTitle/);
  assert.match(detail, /displaySentenceCase\(lead\.leadTitle/);
  assert.match(dashboard, /displaySentenceCase\(lead\.leadTitle/);
  assert.match(css, /Findoly rich lead cards/);
  assert.match(css, /provider-lead-insight-grid\.is-unlocked-grid/);
  assert.match(css, /provider-lead-insight\.is-confirmed/);
});

test("provider actions use the friendly call and WhatsApp language with visible common filters", () => {
  const list = source("views/lead/index.ejs");
  const detail = source("views/lead/show.ejs");
  const css = source("public/css/app.css");

  assert.match(list, /provider-visible-filters/);
  assert.match(list, />City</);
  assert.match(list, />Priority</);
  assert.match(list, />Sort by</);
  assert.match(list, /provider-action-call/);
  assert.match(list, /provider-action-whatsapp/);
  assert.match(list, /provider-action-primary/);
  assert.match(detail, /provider-action-call/);
  assert.match(detail, /provider-action-whatsapp/);
  assert.match(detail, /provider-action-primary/);
  assert.match(css, /Provider action language/);
  assert.match(css, /--provider-mobile-drawer-width/);
  assert.match(css, /inset: var\(--portal-navbar-height\) 0 0 0/);
  assert.match(css, /body\.portal-sidebar-open \.workspace-mobile-nav\.portal-mobile-nav[\s\S]*visibility: hidden/);
});


test("lead lists provide persistent grid and row layouts with neutral card edges", () => {
  const view = source("views/lead/index.ejs");
  const navbar = source("views/partials/navbar.ejs");
  const scripts = source("views/partials/scripts.ejs");
  const css = source("public/css/app.css");

  assert.match(view, /provider-view-switch/);
  assert.match(view, /setViewMode\('grid'\)/);
  assert.match(view, /setViewMode\('row'\)/);
  assert.match(view, /findolyProviderLeadView/);
  assert.match(view, /is-grid-view/);
  assert.match(view, /is-row-view/);
  assert.match(navbar, /id="i-grid"/);
  assert.match(navbar, /id="i-list"/);
  assert.match(css, /neutral cards \+ reliable mobile drawer/);
  assert.match(css, /provider-decision-card::before[\s\S]*display: none/);
  assert.match(css, /is-grid-view[\s\S]*repeat\(2/);
  assert.match(css, /is-row-view[\s\S]*minmax\(0, 1fr\)/);
  assert.match(scripts, /window\.location\.assign\(href\)/);
  assert.match(css, /left: var\(--provider-mobile-drawer-width\)/);
});

test("provider mobile UI follows the approved Findoly logo palette without recolouring cards", () => {
  const navbar = source("views/partials/navbar.ejs");
  const sidebar = source("views/partials/sidebar.ejs");
  const head = source("views/partials/head.ejs");
  const css = source("public/css/app.css");

  assert.match(navbar, /\/images\/findoly-logo\.png/);
  assert.match(sidebar, /workspace-sidebar-drawer-brand/);
  assert.match(sidebar, /\/images\/findoly-logo\.png/);
  assert.match(head, /provider-grid-row-neutral-findoly-logo-/);
  assert.match(css, /Findoly logo-aligned mobile UI/);
  assert.match(css, /--findoly-navy: #072f5f/);
  assert.match(css, /--findoly-orange: #fe6821/);
  assert.match(css, /--findoly-sky: #35b9ef/);
  assert.match(css, /provider-decision-card[\s\S]*background: #fff/);
  assert.match(css, /workspace-mobile-nav\.portal-mobile-nav a\.active::before[\s\S]*var\(--findoly-orange\)/);
});


test("provider workspace separates New requirements from Assigned requirements", () => {
  const controller = source("controllers/frontendController.js");
  const sidebar = source("views/partials/sidebar.ejs");
  const navbar = source("views/partials/navbar.ejs");
  const list = source("views/lead/index.ejs");
  const detail = source("views/lead/show.ejs");
  const dashboard = source("views/dashboard/index.ejs");
  const dashboardService = source("services/dashboard/dashboard-service.js");
  const marketplaceService = source("services/marketplace/marketplace-service.js");
  const leadRoutes = source("routes/lead.js");
  const presenter = source("utils/lead.js");

  assert.match(controller, /"Requirements"/);
  assert.match(controller, /New requirements/);
  assert.match(controller, /"Account credits"/);
  assert.match(controller, /"Credit activity"/);

  assert.match(sidebar, /New requirements/);
  assert.match(sidebar, /Assigned requirements/);
  assert.match(sidebar, /Pending outcomes/);
  assert.match(sidebar, /Follow-ups/);
  assert.match(sidebar, /Account credits/);
  assert.doesNotMatch(sidebar, /Lead marketplace|Find new leads/);

  assert.match(navbar, /New requirements/);
  assert.match(navbar, />New</);
  assert.match(navbar, />Assigned</);
  assert.match(navbar, />Profile</);
  assert.match(navbar, /Pending outcomes/);
  assert.doesNotMatch(navbar, />Find</);

  assert.match(list, /const initialStatus = \['marketplace', 'offered'\]\.includes\(query\.get\('status'\)\) \? 'marketplace' : 'unlocked'/);
  assert.match(list, /Review and unlock Findoly-shared requirements/);
  assert.match(list, /Customer requirements assigned to your account/);
  assert.match(list, /No new requirements/);
  assert.match(list, /No assigned requirements found/);
  assert.doesNotMatch(list, /legacy opportunity|Legacy matched/i);

  assert.match(detail, /Back to new requirements/);
  assert.match(detail, /Back to assigned requirements/);
  assert.match(detail, /Deducted when Findoly assigned this requirement/);
  assert.match(detail, /Deducted when you unlocked this requirement/);
  assert.match(detail, /Requirement unlocked and moved to Assigned requirements/);
  assert.match(detail, /Current outcome/);

  assert.match(dashboard, /View new requirements/);
  assert.match(dashboard, /Review new requirements/);
  assert.match(dashboard, /data\.offered/);
  assert.match(dashboardService, /marketplaceService\.countMarketplace/);
  assert.match(dashboardService, /providerSaleOutcome: "not_confirmed"/);
  assert.match(dashboardService, /const recent = \(unlockedPage\.data \|\| \[\]\)\.slice\(0, 8\)/);

  assert.match(presenter, /assignmentSource: unlock\?\.assignmentSource/);
  assert.match(presenter, /assignedAt: unlock\?\.assignedAt/);
  assert.match(marketplaceService, /async function listMarketplace/);
  assert.match(leadRoutes, /\/:leadId\/unlock/);
});
