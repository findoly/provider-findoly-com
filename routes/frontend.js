const express = require("express");
const frontendController = require("../controllers/frontendController");
const { pageAuth, guestOnly } = require("../middleware/auth");

const router = express.Router();

router.get("/login", guestOnly, frontendController.login);
router.get("/", (req, res) =>
  res.redirect(req.provider ? "/dashboard" : "/login"),
);
router.get("/dashboard", pageAuth, frontendController.dashboard);
router.get("/leads", pageAuth, frontendController.leads);
router.get("/leads/:leadId", pageAuth, frontendController.lead);
router.get("/plans", pageAuth, frontendController.plans);
router.get("/wallet", pageAuth, frontendController.wallet);
router.get("/profile", pageAuth, frontendController.profile);

module.exports = router;
