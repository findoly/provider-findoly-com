const router = require("express").Router();
const controller = require("../controllers/authController");
const {
  sendOtpLimiter,
  verifyOtpLimiter,
} = require("../middleware/rate-limit");

router.post("/send-otp", sendOtpLimiter, controller.sendOtp);
router.post("/verify-otp", verifyOtpLimiter, controller.verifyOtp);
router.post("/logout", controller.logout);

module.exports = router;
