const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const words = (text) => String(text).replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;

const publicPages = [
  ["/terms-and-conditions", "terms", "views/legal/terms-and-conditions.ejs", "Terms and Conditions", 3000],
  ["/privacy-policy", "privacy", "views/legal/privacy-policy.ejs", "Privacy Policy", 1900],
  ["/cancellation-and-refund-policy", "refunds", "views/legal/cancellation-and-refund-policy.ejs", "Cancellation and Refund Policy", 1100],
  ["/shipping-and-service-delivery-policy", "delivery", "views/legal/shipping-and-service-delivery-policy.ejs", "Shipping and Service Delivery Policy", 550],
  ["/acceptable-use-and-lead-data-policy", "acceptableUse", "views/legal/acceptable-use-and-lead-data-policy.ejs", "Acceptable Use and Lead Data Policy", 900],
  ["/marketplace-disclaimer", "marketplaceDisclaimer", "views/legal/marketplace-disclaimer.ejs", "Marketplace Disclaimer", 450],
  ["/cookie-and-storage-notice", "cookies", "views/legal/cookie-and-storage-notice.ejs", "Cookie and Storage Notice", 500],
  ["/intellectual-property-and-complaints-policy", "intellectualProperty", "views/legal/intellectual-property-and-complaints-policy.ejs", "Intellectual Property and Complaints Policy", 500],
  ["/grievance-redressal-policy", "grievance", "views/legal/grievance-redressal-policy.ejs", "Grievance Redressal Policy", 700],
  ["/contact-us", "contact", "views/legal/contact-us.ejs", "Contact Us", 230],
  ["/help-support", "support", "views/legal/help-support.ejs", "Help and Support", 450],
];

test("all expanded policy routes are public and registered before protected pages", () => {
  const routes = read("routes/frontend.js");
  const pageAuthIndex = routes.indexOf('router.get("/dashboard", pageAuth');
  assert.ok(pageAuthIndex > 0);
  for (const [url, handler] of publicPages) {
    const route = `router.get("${url}", frontendController.${handler});`;
    const routeIndex = routes.indexOf(route);
    assert.ok(routeIndex >= 0, `${url} must be registered`);
    assert.ok(routeIndex < pageAuthIndex, `${url} must be registered before protected pages`);
    assert.doesNotMatch(route, /pageAuth|guestOnly/);
  }
});

test("all expanded policy controllers render dedicated pages", () => {
  const controller = read("controllers/frontendController.js");
  for (const [, handler, file, title] of publicPages) {
    const view = file.replace(/^views\//, "").replace(/\.ejs$/, "");
    const pattern = `${handler}: render\\("${view.replaceAll("/", "\\/")}", "${title}"\\)`;
    assert.match(controller, new RegExp(pattern));
    assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist`);
  }
});

test("policy navigation links every public legal page", () => {
  const login = read("views/auth/login.ejs");
  const wallet = read("views/wallet/index.ejs");
  const partial = read("views/partials/policy-links.ejs");
  for (const [url] of publicPages) {
    assert.ok(partial.includes(`href="${url}"`), `${url} must be linked`);
  }
  assert.match(login, /Terms and Conditions/);
  assert.match(login, /supportEmail/);
  assert.match(wallet, /non-refundable/);
  assert.match(wallet, /No physical delivery applies/);
});

test("long-form policies meet approved coverage thresholds and include navigation", () => {
  let totalWords = 0;
  for (const [, , file, , minimumWords] of publicPages) {
    const content = read(file);
    const count = words(content);
    totalWords += count;
    assert.ok(count >= minimumWords, `${file} must contain at least ${minimumWords} words; found ${count}`);
    assert.match(content, /portal-legal-toc/);
    assert.match(content, /Back to contents/);
    assert.match(content, /Effective and last updated: 30 July 2026/);
  }
  assert.ok(totalWords >= 11000, `expanded legal set must contain at least 11,000 words; found ${totalWords}`);
});

test("approved legal identity and core commercial rules are present", () => {
  const terms = read("views/legal/terms-and-conditions.ejs");
  const privacy = read("views/legal/privacy-policy.ejs");
  const contact = read("views/legal/contact-us.ejs");
  const refund = read("views/legal/cancellation-and-refund-policy.ejs");
  const delivery = read("views/legal/shipping-and-service-delivery-policy.ejs");
  const acceptableUse = read("views/legal/acceptable-use-and-lead-data-policy.ejs");
  const grievance = read("views/legal/grievance-redressal-policy.ejs");

  assert.match(contact, /Findoly Solutions LLP/);
  assert.match(contact, /WeWork Mindspace, 6th Floor/);
  assert.match(contact, /Mumbai – 400064/);
  assert.doesNotMatch(contact, /href="tel:|\+91[\s-]?\d{5}/i);
  assert.match(refund, /non-refundable/i);
  assert.match(refund, /does not automatically restore credits/i);
  assert.match(delivery, /No physical shipping/i);
  assert.match(delivery, /payment is successfully verified/i);
  assert.match(terms, /non-transferable/);
  assert.match(terms, /courts having jurisdiction in Mumbai/);
  assert.match(privacy, /access, correction, erasure/i);
  assert.match(acceptableUse, /No sale, sharing or redistribution/);
  assert.match(grievance, /twenty-four hours/);
  assert.match(grievance, /fifteen days/);
  assert.match(grievance, /supportEmail/);
});

test("expanded legal styles include contents, callouts, lists and mobile layout", () => {
  const css = read("public/css/app.css");
  assert.match(css, /\.portal-legal-toc/);
  assert.match(css, /\.portal-legal-callout/);
  assert.match(css, /\.portal-legal-back-link/);
  assert.match(css, /grid-template-columns: repeat\(2/);
  assert.match(css, /\.portal-legal-toc ol \{ grid-template-columns: 1fr; \}/);
});
