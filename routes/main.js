const express = require("express");
const { apiAuth } = require("../middleware/auth");
const dashboardController = require("../controllers/dashboardController");
const profileController = require("../controllers/profileController");

const router = express.Router();

router.use("/auth", require("./auth"));
router.use(apiAuth);
router.get("/dashboard", dashboardController.get);
router.get("/profile", profileController.get);
router.use("/lead", require("./lead"));
router.use("/leads", require("./lead"));
router.use("/wallet", require("./wallet"));

module.exports = router;
