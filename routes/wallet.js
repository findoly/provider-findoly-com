const express = require("express");
const walletController = require("../controllers/walletController");
const { walletLimiter } = require("../middleware/rate-limit");
const { verifyCsrf } = require("../middleware/security");

const router = express.Router();

router.get("/", walletController.get);
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
