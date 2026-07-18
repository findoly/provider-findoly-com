const express = require("express");
const { apiAuth } = require("../middleware/auth");
const dashboardController = require("../controllers/dashboardController");
const profileController = require("../controllers/profileController");
const { verifyCsrf } = require("../middleware/security");

const router = express.Router();

router.use("/auth", require("./auth"));
router.use(apiAuth);
router.get("/dashboard", dashboardController.get);
router.get("/profile", profileController.get);
router.patch("/profile/location", verifyCsrf, profileController.updateLocation);
router.use("/lead", require("./lead"));
router.use("/leads", require("./lead"));
router.use("/wallet", require("./wallet"));
router.use("/billing", require("./wallet"));

module.exports = router;
