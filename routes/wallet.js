const express = require("express");
const walletController = require("../controllers/walletController");
const { walletLimiter } = require("../middleware/rate-limit");

const router = express.Router();

router.get("/", walletController.get);
router.post("/order", walletLimiter, walletController.createOrder);
router.post("/verify", walletLimiter, walletController.verify);

module.exports = router;
