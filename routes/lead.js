const router = require("express").Router();
const controller = require("../controllers/leadController");
const { unlockLimiter } = require("../middleware/rate-limit");

router.get("/", controller.list);
router.get("/:leadDistributionId", controller.get);
router.post(
  "/:leadDistributionId/unlock",
  unlockLimiter,
  controller.unlock,
);

module.exports = router;
