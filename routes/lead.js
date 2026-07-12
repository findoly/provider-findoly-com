const router = require("express").Router();
const controller = require("../controllers/leadController");
const { unlockLimiter, walletLimiter } = require("../middleware/rate-limit");
const { verifyCsrf } = require("../middleware/security");

router.get("/", controller.list);
router.get("/:leadDistributionId", controller.get);
router.post(
  "/:leadDistributionId/unlock",
  verifyCsrf,
  unlockLimiter,
  controller.unlock,
);
router.post(
  "/:leadDistributionId/direct-order",
  verifyCsrf,
  walletLimiter,
  controller.createDirectOrder,
);
router.post(
  "/:leadDistributionId/direct-cancel",
  verifyCsrf,
  walletLimiter,
  controller.cancelDirectPayment,
);
router.post(
  "/:leadDistributionId/direct-verify",
  verifyCsrf,
  walletLimiter,
  controller.verifyDirectPayment,
);
router.patch(
  "/:leadDistributionId/status",
  verifyCsrf,
  controller.updateStatus,
);

module.exports = router;
