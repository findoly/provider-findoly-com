const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

const publicPages = [
  ["/terms-and-conditions", "terms", "views/legal/terms-and-conditions.ejs", "Terms and Conditions"],
  ["/privacy-policy", "privacy", "views/legal/privacy-policy.ejs", "Privacy Policy"],
  ["/cancellation-and-refund-policy", "refunds", "views/legal/cancellation-and-refund-policy.ejs", "Cancellation and Refund Policy"],
  ["/shipping-and-service-delivery-policy", "delivery", "views/legal/shipping-and-service-delivery-policy.ejs", "Shipping and Service Delivery Policy"],
  ["/contact-us", "contact", "views/legal/contact-us.ejs", "Contact Us"],
  ["/help-support", "support", "views/legal/help-support.ejs", "Help and Support"],
];

test("all approved policy routes are public and registered before protected pages", () => {
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

test("all approved policy controllers render their dedicated pages", () => {
  const controller = read("controllers/frontendController.js");
  for (const [, handler, file, title] of publicPages) {
    const view = file.replace(/^views\//, "").replace(/\.ejs$/, "");
    assert.match(controller, new RegExp(`${handler}: render\\("${view.replaceAll("/", "\\/")}", "${title}"\\)`));
    assert.ok(fs.existsSync(path.join(__dirname, "..", file)), `${file} must exist`);
  }
});

test("login and payment pages expose the approved policy links", () => {
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

test("approved legal identity and digital-delivery terms are present", () => {
  const contact = read("views/legal/contact-us.ejs");
  const refund = read("views/legal/cancellation-and-refund-policy.ejs");
  const delivery = read("views/legal/shipping-and-service-delivery-policy.ejs");
  const support = read("views/legal/help-support.ejs");
  assert.match(contact, /Findoly Solutions LLP/);
  assert.match(contact, /WeWork Mindspace, 6th Floor/);
  assert.match(contact, /Mumbai – 400064/);
  assert.doesNotMatch(contact, /tel:|phone number/i);
  assert.match(refund, /non-refundable/i);
  assert.match(delivery, /No physical delivery/i);
  assert.match(delivery, /after the payment has been successfully verified/i);
  assert.match(support, /supportEmail/);
});
