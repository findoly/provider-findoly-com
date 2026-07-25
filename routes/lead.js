const router = require("express").Router();
const controller = require("../controllers/leadController");
const { unlockLimiter, walletLimiter } = require("../middleware/rate-limit");
const { verifyCsrf } = require("../middleware/security");

router.get("/", controller.list);
router.get("/pending-outcomes", controller.pendingOutcomes);
router.get("/:leadId", controller.get);
router.post(
  "/:leadId/unlock",
  verifyCsrf,
  unlockLimiter,
  controller.unlock,
);
router.post(
  "/:leadId/direct-order",
  verifyCsrf,
  walletLimiter,
  controller.createDirectOrder,
);
router.post(
  "/:leadId/direct-cancel",
  verifyCsrf,
  walletLimiter,
  controller.cancelDirectPayment,
);
router.post(
  "/:leadId/direct-verify",
  verifyCsrf,
  walletLimiter,
  controller.verifyDirectPayment,
);
router.patch(
  "/:leadId/status",
  verifyCsrf,
  controller.updateStatus,
);

module.exports = router;
