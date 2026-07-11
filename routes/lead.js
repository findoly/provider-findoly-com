const router = require("express").Router();
const controller = require("../controllers/leadController");
const { unlockLimiter } = require("../middleware/rate-limit");
const { verifyCsrf } = require("../middleware/security");

router.get("/", controller.list);
router.get("/:leadDistributionId", controller.get);
router.post(
  "/:leadDistributionId/unlock",
  unlockLimiter,
  controller.unlock,
);
router.patch(
  "/:leadDistributionId/status",
  verifyCsrf,
  controller.updateStatus,
);

module.exports = router;
