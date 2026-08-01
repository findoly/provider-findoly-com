const express = require("express");
const controller = require("../controllers/providerRequestController");
const { verifyCsrf } = require("../middleware/security");
const { providerJoinLimiter } = require("../middleware/rate-limit");

const router = express.Router();

router.post("/", providerJoinLimiter, verifyCsrf, controller.create);

module.exports = router;
