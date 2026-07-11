require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const helmet = require("helmet");
const morgan = require("morgan");
const mongoose = require("mongoose");
const { attachProvider } = require("./middleware/auth");
const { ensureCsrfToken, verifyCsrf } = require("./middleware/security");
const { apiLimiter } = require("./middleware/rate-limit");
const { notFound, errorHandler } = require("./middleware/error");
const walletController = require("./controllers/walletController");
const frontendRoutes = require("./routes/frontend");
const apiRoutes = require("./routes/main");

const app = express();

app.locals.appName = process.env.APP_NAME || "Provider Lead Portal";
app.locals.apiBase = "/api";
app.locals.csrfCookieName =
  process.env.CSRF_COOKIE_NAME || "provider_csrf";
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use((req, res, next) => {
  req.requestId = req.get("x-request-id") || crypto.randomUUID();
  res.set("x-request-id", req.requestId);
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", "https://api.razorpay.com"],
        imgSrc: ["'self'", "data:", "https://*.razorpay.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "data:"],
        scriptSrc: [
          "'self'",
          (req, res) => `'nonce-${res.locals.cspNonce}'`,
          "'unsafe-eval'",
          "https://checkout.razorpay.com",
        ],
        connectSrc: ["'self'", "https://*.razorpay.com"],
        frameSrc: ["https://api.razorpay.com", "https://*.razorpay.com"],
      },
    },
    referrerPolicy: { policy: "same-origin" },
  }),
);
app.use(compression());
app.use(
  morgan(process.env.NODE_ENV === "production" ? "combined" : "dev", {
    skip: (req) => req.path === "/api/health",
  }),
);

app.post(
  "/api/webhooks/razorpay",
  express.raw({ type: "application/json", limit: "256kb" }),
  walletController.webhook,
);

app.use(express.json({ limit: "256kb", strict: true }));
app.use(express.urlencoded({ extended: false, limit: "128kb" }));
app.use(cookieParser());
app.use(ensureCsrfToken);
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    maxAge: process.env.NODE_ENV === "production" ? "7d" : 0,
    immutable: process.env.NODE_ENV === "production",
  }),
);
app.get("/api/health", (req, res) => {
  const databaseReady =
    process.env.SKIP_DB === "true" || mongoose.connection.readyState === 1;
  return res.status(databaseReady ? 200 : 503).json({
    success: databaseReady,
    data: {
      service: "provider-lead-portal",
      status: databaseReady ? "ready" : "not_ready",
    },
  });
});

app.use(attachProvider);
app.use("/", frontendRoutes);
app.use("/frontend", frontendRoutes);
app.use("/api", apiLimiter, verifyCsrf, apiRoutes);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
