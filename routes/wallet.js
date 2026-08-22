const express = require("express");
const walletController = require("../controllers/walletController");
const { walletLimiter } = require("../middleware/rate-limit");
const { verifyCsrf } = require("../middleware/security");

const router = express.Router();

router.get("/", walletController.get);
router.get("/packages", walletController.packages);
router.post(
  "/credits/order",
  verifyCsrf,
  walletLimiter,
  walletController.createCreditOrder,
);
router.post(
  "/credits/cancel",
  verifyCsrf,
  walletLimiter,
  walletController.cancelCreditOrder,
);
router.post(
  "/credits/verify",
  verifyCsrf,
  walletLimiter,
  walletController.verifyCredits,
);

// Legacy plan routes remain available only for already-started checkouts.
router.post(
  "/plan/order",
  verifyCsrf,
  walletLimiter,
  walletController.createPlanOrder,
);
router.post(
  "/plan/cancel",
  verifyCsrf,
  walletLimiter,
  walletController.cancelPlanOrder,
);
router.post("/verify", verifyCsrf, walletLimiter, walletController.verify);

module.exports = router;
