const express = require("express");
const frontendController = require("../controllers/frontendController");
const { pageAuth, guestOnly } = require("../middleware/auth");
const { captureForPage } = require("../middleware/direct-lead-access");
const providerRequestController = require("../controllers/providerRequestController");

const router = express.Router();

router.get("/login", guestOnly, frontendController.login);
router.get("/join-as-provider", guestOnly, providerRequestController.page);
router.get("/terms-and-conditions", frontendController.terms);
router.get("/privacy-policy", frontendController.privacy);
router.get("/cancellation-and-refund-policy", frontendController.refunds);
router.get("/shipping-and-service-delivery-policy", frontendController.delivery);
router.get("/acceptable-use-and-lead-data-policy", frontendController.acceptableUse);
router.get("/marketplace-disclaimer", frontendController.marketplaceDisclaimer);
router.get("/cookie-and-storage-notice", frontendController.cookies);
router.get("/intellectual-property-and-complaints-policy", frontendController.intellectualProperty);
router.get("/grievance-redressal-policy", frontendController.grievance);
router.get("/contact-us", frontendController.contact);
router.get("/help-support", frontendController.support);
router.get("/", (req, res) =>
  res.redirect(req.provider ? "/dashboard" : "/login"),
);
router.get("/dashboard", pageAuth, frontendController.dashboard);
router.get("/leads", pageAuth, frontendController.leads);
router.get("/lead/:leadId", (req, res) => {
  const queryIndex = req.originalUrl.indexOf("?");
  const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
  return res.redirect(302, `/leads/${encodeURIComponent(req.params.leadId)}${query}`);
});
router.get("/leads/:leadId", pageAuth, captureForPage, frontendController.lead);
router.get("/plans", pageAuth, frontendController.plans);
router.get("/wallet", pageAuth, frontendController.wallet);
router.get("/profile", pageAuth, frontendController.profile);

module.exports = router;
